"""Local OneBot test peer; never connects to a real account."""
import asyncio
import json
import sys
import websockets

peers = {}
sends = []
mode = 'ok'
rejected = set()
async def handle(ws, path):
    global mode
    account = path.lstrip('/')
    if ws.request_headers.get('Authorization') != 'Bearer local-qa-token':
        await ws.close(1008)
        return
    if account in rejected:
        await ws.close(1013)
        return
    peers[account] = ws
    try:
        async for line in ws:
            value = json.loads(line)
            if value['action'] == 'get_login_info':
                result = {'user_id': int(account)}
            else:
                sends.append({'account': account, **value})
                if mode == 'drop':
                    mode = 'ok'
                    await ws.close()
                    break
                if mode == 'hold':
                    mode = 'ok'
                    continue
                result = {'message_id': len(sends)}
            await ws.send(json.dumps({'status': 'ok', 'retcode': 0, 'data': result, 'echo': value['echo']}))
    except websockets.ConnectionClosed:
        pass
    finally:
        if peers.get(account) is ws:
            peers.pop(account, None)

async def control():
    global mode
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        value = json.loads(line)
        try:
            if value['action'] == 'event':
                await peers[value['account']].send(json.dumps(value['event']))
                result = True
            elif value['action'] == 'drop_next':
                mode, result = 'drop', True
            elif value['action'] == 'hold_next':
                mode, result = 'hold', True
            elif value['action'] == 'snapshot':
                result = {'peers': list(peers), 'sends': sends, 'rejected': sorted(rejected)}
            elif value['action'] == 'reject_account':
                rejected.add(value['account'])
                if value['account'] in peers:
                    await peers[value['account']].close(1013)
                result = True
            elif value['action'] == 'allow_account':
                rejected.discard(value['account'])
                result = True
            else:
                result = None
            print(json.dumps({'id': value['id'], 'result': result}), flush=True)
        except Exception as exc:
            print(json.dumps({'id': value['id'], 'error': type(exc).__name__}), flush=True)

async def main():
    async with websockets.serve(handle, '127.0.0.1', 0) as server:
        print(json.dumps({'port': server.sockets[0].getsockname()[1]}), flush=True)
        await control()
asyncio.run(main())
