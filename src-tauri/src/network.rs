//! Shared public-network DNS boundary for host-owned web actions.
//!
//! URL string checks are not enough: a public-looking hostname can resolve to
//! a loopback, private, link-local, or metadata address.  This resolver drops
//! those addresses before reqwest opens a socket.  Callers still validate the
//! final response address because DNS and redirect behavior are independent
//! boundaries.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

pub struct PublicDnsResolver;

pub fn resolver() -> Arc<PublicDnsResolver> {
    Arc::new(PublicDnsResolver)
}

impl reqwest::dns::Resolve for PublicDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)?;
            let allowed = addresses
                .filter(|address| !is_private_or_loopback(address.ip()))
                .collect::<Vec<SocketAddr>>();
            if allowed.is_empty() {
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "public network DNS resolution returned only local or private addresses",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(allowed.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

pub fn is_private_or_loopback(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || octets[0] == 0
                || octets[0] >= 240
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        }
        IpAddr::V6(ip) => {
            ip.to_ipv4_mapped()
                .is_some_and(|mapped| is_private_or_loopback(IpAddr::V4(mapped)))
                || ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_private_and_special_ranges() {
        for value in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(is_private_or_loopback(value.parse().unwrap()), "{value}");
        }
        assert!(!is_private_or_loopback("8.8.8.8".parse().unwrap()));
    }

    #[tokio::test]
    async fn rejects_localhost_before_a_request_is_opened() {
        let resolving = <PublicDnsResolver as reqwest::dns::Resolve>::resolve(
            &PublicDnsResolver,
            "localhost".parse().unwrap(),
        );
        assert!(resolving.await.is_err());
    }
}
