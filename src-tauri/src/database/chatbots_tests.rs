use super::*;

#[test]
fn chatbots_desktop_config_routes_and_single_controller() {
    let db = db();
    let b = bot(&db, "desktop");
    let config = DesktopConfig {
        version: 1,
        window_title: "钉钉".into(),
        self_names: vec!["小明".into()],
        layout: DesktopLayout {
            title: [0.3, 0.04, 0.8, 0.1],
            messages: [0.3, 0.12, 0.98, 0.64],
            editor: [0.3, 0.7, 0.98, 0.9],
            sidebar: [0.1, 0.15, 0.28, 0.9],
            send: [0.93, 0.94],
        },
    };
    let a = Account {
        id: String::new(),
        name: "Local".into(),
        platform: "dingtalk_desktop".into(),
        app_id: "local-desktop".into(),
        tenant_id: String::new(),
        endpoint: String::new(),
        enabled: true,
        desktop: Some(config.clone()),
    };
    let mut invalid = a.clone();
    invalid.desktop = None;
    assert!(db.chat_save_account(invalid).is_err());
    let a = db.chat_save_account(a).unwrap();
    let mut duplicate = a.clone();
    duplicate.id.clear();
    duplicate.app_id = "other".into();
    assert!(db.chat_save_account(duplicate).is_err());
    let r = route(&db, &b, &a, "测试群");
    let mut collision = r.clone();
    collision.id.clear();
    collision.chat_type = "group".into();
    assert!(db.chat_save_route(collision).is_err());
    let mut group = r.clone();
    group.id.clear();
    group.chat_id = "另一个群".into();
    group.chat_type = "group".into();
    group.mode = "all".into();
    let group = db.chat_save_route(group).unwrap();
    let mut wildcard = group.clone();
    wildcard.id.clear();
    wildcard.scope = "all".into();
    assert!(db.chat_save_route(wildcard).is_err());
    let mut incoming = message("desktop-mention", &group.chat_id);
    incoming.chat_type = "group".into();
    incoming.mentioned = true;
    db.chat_receive(&a.id, incoming).unwrap();
    assert!(db.chat_claim().unwrap().is_some());
    let mut bad = config;
    bad.layout.send[0] = 2.0;
    assert!(bad.validate().is_err());
}

#[test]
fn chatbots_desktop_preinput_deferral_keeps_reply_and_respects_pause() {
    let db = db();
    let b = bot(&db, "desktop-defer");
    let mut a = account(&db, "desktop-defer");
    a.id.clear();
    a.platform = "dingtalk_desktop".into();
    a.tenant_id.clear();
    a.desktop = Some(DesktopConfig {
        version: 1,
        window_title: "钉钉".into(),
        self_names: vec!["我".into()],
        layout: DesktopLayout {
            title: [0.3, 0.04, 0.8, 0.1],
            messages: [0.3, 0.12, 0.98, 0.64],
            editor: [0.3, 0.7, 0.98, 0.9],
            sidebar: [0.1, 0.15, 0.28, 0.9],
            send: [0.93, 0.94],
        },
    });
    let a = db.chat_save_account(a).unwrap();
    let mut r = route(&db, &b, &a, "defer-chat");
    db.chat_receive(&a.id, message("defer-message", &r.chat_id))
        .unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    complete(&db, &job);
    let delivery = db.chat_delivery(&a.id).unwrap().unwrap();
    db.chat_delivery_deferred(&a.id, &delivery.id).unwrap();
    assert!(
        db.chat_claim().unwrap().is_none(),
        "Deferral must not regenerate a reply"
    );
    let retried = db.chat_delivery(&a.id).unwrap().unwrap();
    assert_eq!(retried.id, delivery.id);
    assert_eq!(retried.text, delivery.text);
    r.paused = true;
    db.chat_save_route(r).unwrap();
    db.chat_delivery_deferred(&a.id, &delivery.id).unwrap();
    assert!(db.chat_delivery(&a.id).unwrap().is_none());
    let d = db.chat_dashboard().unwrap();
    assert_eq!(d.messages[0].delivery.as_deref(), Some("cancelled"));
    let official = account(&db, "official");
    assert!(
        db.chat_delivery_deferred(&official.id, &delivery.id)
            .is_err()
    );
}
fn db() -> Database {
    Database::from_connection(Connection::open_in_memory().unwrap()).unwrap()
}
fn bot(db: &Database, pet: &str) -> Bot {
    db.chat_save_bot(Bot {
        id: String::new(),
        pet_id: pet.into(),
        name: pet.into(),
        profile_id: "test-model".into(),
        persona: format!("Persona for {pet}"),
        enabled: true,
        revision: 0,
        daily_reply_limit: 100,
        cooldown_seconds: 0,
    })
    .unwrap()
}
fn account(db: &Database, name: &str) -> Account {
    db.chat_save_account(Account {
        id: String::new(),
        name: name.into(),
        platform: "feishu".into(),
        app_id: name.into(),
        tenant_id: "tenant".into(),
        endpoint: String::new(),
        enabled: true,
        desktop: None,
    })
    .unwrap()
}
fn route(db: &Database, b: &Bot, a: &Account, chat: &str) -> Route {
    db.chat_save_route(Route {
        id: String::new(),
        bot_id: b.id.clone(),
        account_id: a.id.clone(),
        chat_type: "direct".into(),
        scope: "exact".into(),
        chat_id: chat.into(),
        topic_id: String::new(),
        mode: "mention".into(),
        paused: false,
    })
    .unwrap()
}
fn message(id: &str, chat: &str) -> Inbound {
    Inbound {
        message_id: id.into(),
        chat_type: "direct".into(),
        chat_id: chat.into(),
        topic_id: String::new(),
        sender_id: "human".into(),
        text: "Hello 知识库".into(),
        mentioned: false,
        sender_bot: false,
        context: serde_json::json!({"secret":"never persist"}),
    }
}
fn complete(db: &Database, job: &Job) {
    db.chat_generated(job, "Public reply", 11, 7).unwrap();
}
#[test]
fn chatbots_routing_collision_dedup_and_account_isolation() {
    let db = db();
    let a = account(&db, "a");
    let other = account(&db, "other");
    let b = bot(&db, "pet-a");
    let b2 = bot(&db, "pet-b");
    let r = route(&db, &b, &a, "same-chat");
    let _ = route(&db, &b2, &other, "same-chat");
    let mut collision = r.clone();
    collision.id.clear();
    collision.bot_id = b2.id.clone();
    assert!(db.chat_save_route(collision).is_err());
    let id = db.chat_receive(&a.id, message("m1", "same-chat")).unwrap();
    assert_eq!(
        id,
        db.chat_receive(&a.id, message("m1", "same-chat")).unwrap()
    );
    db.chat_receive(&other.id, message("m1", "same-chat"))
        .unwrap();
    let first = db.chat_claim().unwrap().unwrap();
    let second = db.chat_claim().unwrap().unwrap();
    assert_ne!(first.session, second.session);
    assert_ne!(first.bot.id, second.bot.id);
    assert_eq!(first.inbound.context, serde_json::Value::Null);
    assert_eq!(db.chat_dashboard().unwrap().messages.len(), 2);
}
#[test]
fn chatbots_pause_blocks_generation_and_unsent_delivery() {
    let db = db();
    let a = account(&db, "a");
    let b = bot(&db, "pet");
    let mut r = route(&db, &b, &a, "chat");
    db.chat_receive(&a.id, message("m1", "chat")).unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    r.paused = true;
    db.chat_save_route(r.clone()).unwrap();
    assert!(!db.chat_job_active(&job.id).unwrap());
    complete(&db, &job);
    assert!(db.chat_delivery(&a.id).unwrap().is_none());
    r.paused = false;
    db.chat_save_route(r.clone()).unwrap();
    db.chat_receive(&a.id, message("m2", "chat")).unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    complete(&db, &job);
    r.paused = true;
    db.chat_save_route(r).unwrap();
    assert!(db.chat_delivery(&a.id).unwrap().is_none());
    assert!(
        db.chat_dashboard()
            .unwrap()
            .messages
            .iter()
            .all(|m| m.status == "cancelled")
    );
}
#[test]
fn chatbots_unknown_delivery_blocks_session_until_owner_resolves() {
    let db = db();
    let a = account(&db, "a");
    let b = bot(&db, "pet");
    route(&db, &b, &a, "chat");
    let id = db.chat_receive(&a.id, message("m1", "chat")).unwrap();
    db.chat_receive(&a.id, message("m2", "chat")).unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    assert!(db.chat_claim().unwrap().is_none());
    complete(&db, &job);
    let send = db.chat_delivery(&a.id).unwrap().unwrap();
    assert!(db.chat_claim().unwrap().is_none());
    db.chat_delivery_result(&a.id, &send.id, "delivery_unknown")
        .unwrap();
    assert!(db.chat_delivery(&a.id).unwrap().is_none());
    assert!(db.chat_claim().unwrap().is_none());
    db.chat_resolve_delivery(&id, true).unwrap();
    let next = db.chat_claim().unwrap().unwrap();
    assert_eq!(next.inbound.message_id, "m2");
    assert_eq!(db.chat_context(&next).unwrap().0.len(), 1);
}
#[test]
fn chatbots_recovery_never_resends_or_regenerates_uncertain_work() {
    let db = db();
    let a = account(&db, "a");
    let b = bot(&db, "pet");
    route(&db, &b, &a, "chat");
    route(&db, &b, &a, "other");
    db.chat_receive(&a.id, message("m1", "chat")).unwrap();
    db.chat_receive(&a.id, message("m2", "other")).unwrap();
    let first = db.chat_claim().unwrap().unwrap();
    let second = db.chat_claim().unwrap().unwrap();
    complete(&db, &first);
    db.chat_delivery(&a.id).unwrap().unwrap();
    db.chat_recover().unwrap();
    assert!(!db.chat_job_active(&second.id).unwrap());
    assert!(db.chat_claim().unwrap().is_none());
    assert!(db.chat_delivery(&a.id).unwrap().is_none());
    let d = db.chat_dashboard().unwrap();
    assert!(d.messages.iter().any(|m| m.status == "interrupted"));
    assert!(
        d.messages
            .iter()
            .any(|m| m.delivery.as_deref() == Some("delivery_unknown"))
    );
}
#[test]
fn chatbots_knowledge_acl_applies_before_retrieval_and_delete() {
    let db = db();
    let a = account(&db, "a");
    let b = bot(&db, "pet");
    let other = bot(&db, "other");
    let r = route(&db, &b, &a, "chat");
    let r2 = route(&db, &b, &a, "private");
    let shared = db
        .chat_save_knowledge(Knowledge {
            id: String::new(),
            bot_id: b.id.clone(),
            route_id: String::new(),
            title: "Shared".into(),
            content: "Approved knowledge".into(),
        })
        .unwrap();
    db.chat_save_knowledge(Knowledge {
        id: String::new(),
        bot_id: b.id.clone(),
        route_id: r2.id.clone(),
        title: "Private".into(),
        content: "Private secret".into(),
    })
    .unwrap();
    db.chat_save_knowledge(Knowledge {
        id: String::new(),
        bot_id: other.id.clone(),
        route_id: String::new(),
        title: "Other".into(),
        content: "Another bot secret".into(),
    })
    .unwrap();
    assert!(
        db.chat_save_knowledge(Knowledge {
            id: String::new(),
            bot_id: other.id,
            route_id: r.id,
            title: "Cross bot".into(),
            content: "Leak".into()
        })
        .is_err()
    );
    db.chat_receive(&a.id, message("m1", "chat")).unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    let knowledge = db.chat_context(&job).unwrap().1;
    assert_eq!(knowledge.len(), 1);
    assert_eq!(knowledge[0].title, "Shared");
    db.chat_delete("knowledge", &shared.id).unwrap();
    assert!(db.chat_context(&job).unwrap().1.is_empty());
    assert!(!db.chat_job_active(&job.id).unwrap());
}
#[test]
fn chatbots_history_deletion_retains_dedup_tombstones() {
    let db = db();
    let a = account(&db, "a");
    let b = bot(&db, "pet");
    route(&db, &b, &a, "chat");
    let id = db.chat_receive(&a.id, message("m1", "chat")).unwrap();
    db.chat_delete("history", &b.id).unwrap();
    assert!(db.chat_dashboard().unwrap().messages.is_empty());
    assert_eq!(db.chat_receive(&a.id, message("m1", "chat")).unwrap(), id);
    assert!(db.chat_claim().unwrap().is_none());
}
#[test]
fn chatbots_self_messages_allowlist_and_budget_are_enforced() {
    let db = db();
    let a = account(&db, "a");
    let mut b = bot(&db, "pet");
    b.daily_reply_limit = 1;
    let b = db.chat_save_bot(b).unwrap();
    route(&db, &b, &a, "chat");
    let mut own = message("own", "chat");
    own.sender_bot = true;
    db.chat_receive(&a.id, own).unwrap();
    db.chat_receive(&a.id, message("unrouted", "other"))
        .unwrap();
    assert!(db.chat_claim().unwrap().is_none());
    db.chat_receive(&a.id, message("first", "chat")).unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    complete(&db, &job);
    let send = db.chat_delivery(&a.id).unwrap().unwrap();
    db.chat_delivery_result(&a.id, &send.id, "sent").unwrap();
    db.chat_receive(&a.id, message("second", "chat")).unwrap();
    assert!(db.chat_claim().unwrap().is_none());
    assert_eq!(
        db.chat_dashboard().unwrap().messages[0].status,
        "rate_limited"
    );
}

#[test]
fn chatbots_relation_memory_isolated_by_speaker_chat_and_bot() {
    let db = db();
    let a = account(&db, "a");
    let b = bot(&db, "pet");
    let other = bot(&db, "other");
    let r = route(&db, &b, &a, "chat");
    let r2 = route(&db, &b, &a, "private");
    let memory = db
        .chat_save_memory(RelationMemory {
            id: String::new(),
            bot_id: b.id.clone(),
            route_id: r.id.clone(),
            sender_id: "human".into(),
            content: "Scoped relationship".into(),
        })
        .unwrap();
    assert!(
        db.chat_save_memory(RelationMemory {
            id: String::new(),
            bot_id: other.id,
            route_id: r.id.clone(),
            sender_id: "human".into(),
            content: "Leak".into()
        })
        .is_err()
    );
    db.chat_receive(&a.id, message("m1", "chat")).unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    assert_eq!(db.chat_memory_context(&job).unwrap().len(), 1);
    let mut different = job.clone();
    different.inbound.sender_id = "other-human".into();
    assert!(db.chat_memory_context(&different).unwrap().is_empty());
    different.inbound.sender_id = "human".into();
    different.route_id = r2.id;
    assert!(db.chat_memory_context(&different).unwrap().is_empty());
    db.chat_delete("memory", &memory.id).unwrap();
    assert!(db.chat_memory_context(&job).unwrap().is_empty());
    assert!(!db.chat_job_active(&job.id).unwrap());
}

#[test]
fn chatbots_retrieval_finds_relevant_text_beyond_document_prefix() {
    let db = db();
    let a = account(&db, "a");
    let b = bot(&db, "pet");
    route(&db, &b, &a, "chat");
    db.chat_save_knowledge(Knowledge {
        id: String::new(),
        bot_id: b.id.clone(),
        route_id: String::new(),
        title: "Long document".into(),
        content: format!("{}知识库答案位于尾部", "irrelevant ".repeat(2000)),
    })
    .unwrap();
    db.chat_receive(&a.id, message("m1", "chat")).unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    assert!(
        db.chat_context(&job).unwrap().1[0]
            .content
            .contains("答案位于尾部")
    );
}

#[test]
fn chatbots_budget_survives_cancellation_and_history_deletion() {
    let db = db();
    let a = account(&db, "a");
    let mut b = bot(&db, "pet");
    b.daily_reply_limit = 1;
    let b = db.chat_save_bot(b).unwrap();
    route(&db, &b, &a, "chat");
    db.chat_receive(&a.id, message("m1", "chat")).unwrap();
    db.chat_claim().unwrap().unwrap();
    db.chat_delete("history", &b.id).unwrap();
    db.chat_receive(&a.id, message("m2", "chat")).unwrap();
    assert!(db.chat_claim().unwrap().is_none());
    assert_eq!(db.chat_dashboard().unwrap().usage[0].replies_today, 1);
}

#[test]
fn chatbots_unresolved_delivery_survives_recent_message_window() {
    let db = db();
    let a = account(&db, "a");
    let b = bot(&db, "pet");
    route(&db, &b, &a, "chat");
    let id = db
        .chat_receive(&a.id, message("uncertain", "chat"))
        .unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    complete(&db, &job);
    let send = db.chat_delivery(&a.id).unwrap().unwrap();
    db.chat_delivery_result(&a.id, &send.id, "delivery_unknown")
        .unwrap();
    for n in 0..220 {
        db.chat_receive(&a.id, message(&format!("unrouted-{n}"), "unbound"))
            .unwrap();
    }
    db.chat_receive(&a.id, message("waiting", "chat")).unwrap();
    assert!(db.chat_claim().unwrap().is_none());
    let visible = db.chat_dashboard().unwrap().messages;
    assert_eq!(visible.len(), 201);
    assert_eq!(visible[0].id, id);
    assert_eq!(visible[0].delivery.as_deref(), Some("delivery_unknown"));
    db.chat_resolve_delivery(&id, false).unwrap();
    assert_eq!(db.chat_dashboard().unwrap().messages.len(), 200);
    assert_eq!(
        db.chat_claim().unwrap().unwrap().inbound.message_id,
        "waiting"
    );
}

#[test]
fn chatbots_group_mentions_topics_and_unsupported_media_respect_routes() {
    let db = db();
    let a = account(&db, "group-account");
    let b = bot(&db, "pet");
    let mut r = Route {
        id: String::new(),
        bot_id: b.id.clone(),
        account_id: a.id.clone(),
        chat_type: "group".into(),
        scope: "exact".into(),
        chat_id: "group".into(),
        topic_id: "topic-a".into(),
        mode: "mention".into(),
        paused: false,
    };
    r = db.chat_save_route(r).unwrap();
    let mut incoming = message("ordinary", "group");
    incoming.chat_type = "group".into();
    incoming.topic_id = "topic-a".into();
    db.chat_receive(&a.id, incoming.clone()).unwrap();
    assert_eq!(
        db.chat_dashboard().unwrap().messages[0].status,
        "ignored_trigger"
    );
    assert!(db.chat_claim().unwrap().is_none());
    incoming.message_id = "wrong-topic".into();
    incoming.mentioned = true;
    incoming.topic_id = "topic-b".into();
    db.chat_receive(&a.id, incoming.clone()).unwrap();
    assert_eq!(db.chat_dashboard().unwrap().messages[0].status, "unrouted");
    incoming.message_id = "media".into();
    incoming.topic_id = "topic-a".into();
    incoming.text.clear();
    db.chat_receive(&a.id, incoming.clone()).unwrap();
    assert_eq!(
        db.chat_dashboard().unwrap().messages[0].status,
        "unsupported_media"
    );
    incoming.message_id = "mention".into();
    incoming.text = "Only this topic should answer".into();
    db.chat_receive(&a.id, incoming.clone()).unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    assert_eq!(job.route_id, r.id);
    r.mode = "all".into();
    db.chat_save_route(r.clone()).unwrap();
    incoming.message_id = "all-text".into();
    incoming.mentioned = false;
    db.chat_receive(&a.id, incoming).unwrap();
    assert_eq!(
        db.chat_claim().unwrap().unwrap().inbound.message_id,
        "all-text"
    );
    for platform in ["qq", "dingtalk"] {
        let mut limited = a.clone();
        limited.id.clear();
        limited.platform = platform.into();
        let limited = db.chat_save_account(limited).unwrap();
        let mut unsupported = r.clone();
        unsupported.id.clear();
        unsupported.account_id = limited.id;
        assert!(db.chat_save_route(unsupported).is_err());
    }
}

#[test]
fn chatbots_all_scope_legacy_defaults_precedence_and_isolation() {
    let db = db();
    let a = account(&db, "scope-account");
    let other = account(&db, "scope-other-account");
    let b = bot(&db, "scope-bot");
    let r = route(&db, &b, &a, "specific");
    let mut legacy = serde_json::to_value(&r).unwrap();
    legacy.as_object_mut().unwrap().remove("scope");
    assert_eq!(
        serde_json::from_value::<Route>(legacy).unwrap().scope,
        "exact"
    );
    let mut all = r.clone();
    all.id.clear();
    all.scope = "all".into();
    let all = db.chat_save_route(all).unwrap();
    assert_eq!(all.chat_id, "*");
    db.chat_receive(&a.id, message("scope-1", "new-peer"))
        .unwrap();
    let first = db.chat_claim().unwrap().unwrap();
    assert_eq!(first.route_id, all.id);
    complete(&db, &first);
    let delivery = db.chat_delivery(&a.id).unwrap().unwrap();
    db.chat_delivery_result(&a.id, &delivery.id, "sent")
        .unwrap();
    db.chat_receive(&a.id, message("scope-2", "another-peer"))
        .unwrap();
    let second = db.chat_claim().unwrap().unwrap();
    assert_ne!(first.session, second.session);
    assert!(db.chat_context(&second).unwrap().0.is_empty());
    assert!(
        db.chat_save_memory(RelationMemory {
            id: String::new(),
            bot_id: b.id.clone(),
            route_id: all.id.clone(),
            sender_id: "human".into(),
            content: "Do not share this across chats".into()
        })
        .is_err()
    );
    db.chat_receive(&a.id, message("scope-exact", "specific"))
        .unwrap();
    assert_eq!(db.chat_claim().unwrap().unwrap().route_id, r.id);
    let mut paused = r;
    paused.paused = true;
    db.chat_save_route(paused).unwrap();
    db.chat_receive(&a.id, message("scope-paused", "specific"))
        .unwrap();
    db.chat_receive(&other.id, message("scope-other", "new-peer"))
        .unwrap();
    let mut group_message = message("scope-group", "new-group");
    group_message.chat_type = "group".into();
    db.chat_receive(&a.id, group_message).unwrap();
    let d = db.chat_dashboard().unwrap();
    assert_eq!(
        d.messages
            .iter()
            .find(|m| m.text == "Hello 知识库" && m.chat_id == "specific" && m.status == "paused")
            .unwrap()
            .route_id,
        paused_id(&d, "specific")
    );
    assert_eq!(
        d.messages.iter().filter(|m| m.status == "unrouted").count(),
        2
    );
}
fn paused_id(d: &Dashboard, chat: &str) -> String {
    d.routes
        .iter()
        .find(|r| r.chat_id == chat)
        .unwrap()
        .id
        .clone()
}

#[test]
fn chatbots_exact_override_cancels_fallback_and_batch_rolls_back() {
    let db = db();
    let a = account(&db, "override-account");
    let b = bot(&db, "override-bot");
    let seed = route(&db, &b, &a, "seed");
    let mut all = seed.clone();
    all.id.clear();
    all.scope = "all".into();
    let all = db.chat_save_route(all).unwrap();
    db.chat_receive(&a.id, message("override-1", "excluded"))
        .unwrap();
    let job = db.chat_claim().unwrap().unwrap();
    complete(&db, &job);
    let mut excluded = seed.clone();
    excluded.id.clear();
    excluded.chat_id = "excluded".into();
    excluded.paused = true;
    db.chat_save_route(excluded).unwrap();
    assert!(db.chat_delivery(&a.id).unwrap().is_none());
    assert_eq!(
        db.chat_dashboard().unwrap().messages[0].delivery.as_deref(),
        Some("cancelled")
    );
    let mut valid = seed.clone();
    valid.id.clear();
    valid.chat_id = "batch-valid".into();
    let mut collision = seed.clone();
    collision.id.clear();
    let mut paused_all = all.clone();
    paused_all.paused = true;
    assert!(
        db.chat_save_routes(vec![paused_all, valid, collision])
            .is_err()
    );
    let d = db.chat_dashboard().unwrap();
    assert!(!d.routes.iter().any(|r| r.chat_id == "batch-valid"));
    assert!(!d.routes.iter().find(|r| r.id == all.id).unwrap().paused);
    let mut group = all.clone();
    group.id.clear();
    group.chat_type = "group".into();
    db.chat_save_route(group).unwrap();
    let mut plain = message("group-scope-plain", "future-group");
    plain.chat_type = "group".into();
    db.chat_receive(&a.id, plain.clone()).unwrap();
    plain.message_id = "group-scope-at".into();
    plain.mentioned = true;
    db.chat_receive(&a.id, plain).unwrap();
    assert_eq!(
        db.chat_dashboard()
            .unwrap()
            .messages
            .iter()
            .filter(|m| m.status == "ignored_trigger")
            .count(),
        1
    );
    let group_job = db.chat_claim().unwrap().unwrap();
    assert_eq!(group_job.inbound.chat_id, "future-group");
    assert_eq!(group_job.inbound.chat_type, "group");
}
