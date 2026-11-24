import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import headless from '@xterm/headless'
import { OutputReplayBuffer } from '../modules/pty/output-replay-buffer.js'
import { authenticateExternalTerminalRequest, registerExternalTerminalRoutes } from './external-terminal.routes.js'
import { AppError } from '../utils/app-error.js'

const token = 'test-token-with-at-least-32-characters'
const headers = { authorization: 'Bearer ' + token }
const apps: ReturnType<typeof Fastify>[] = []
const screens: InstanceType<typeof headless.Terminal>[] = []

async function fixture() {
  vi.stubEnv('WORKTREEHUB_API_TOKEN', token)
  const app = Fastify()
  apps.push(app)
  app.addHook('onRequest', async request => authenticateExternalTerminalRequest(request))
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({code:error.code})
    return reply.code(500).send({error: String(error)})
  })
  const screen = new headless.Terminal({cols:40,rows:5,allowProposedApi:true})
  screens.push(screen)
  const outputBuffer = new OutputReplayBuffer(1024)
  const raw = 'first\r\nsecond\r\nthird'
  outputBuffer.push(raw)
  await new Promise<void>(resolve => screen.write(raw, resolve))
  const writeToTerminal = vi.fn()
  const sessions = [{id:'one',status:'running',projectId:'p1',worktreeId:'w1'},{id:'two',status:'exited',projectId:'p2',worktreeId:'w2'}]
  const renameTerminal = vi.fn((id:string, input:{title:string}) => {
    const session = sessions.find(item => item.id === id)!
    Object.assign(session, input)
    return {...session, ...input}
  })
  const deleteTerminal = vi.fn((id:string) => {
    const index = sessions.findIndex(item => item.id === id)
    if (index === -1) throw new AppError('TERMINAL_NOT_FOUND', 'Terminal not found')
    sessions.splice(index, 1)
  })
  const hasRuntime = (id:string) => id === 'one' && sessions.some(item => item.id === id)
  const runtime = {screen,outputBuffer}
  await registerExternalTerminalRoutes(app, {listTerminals:()=>sessions,writeToTerminal,renameTerminal,deleteTerminal} as never,
    {has:hasRuntime,get:(id:string)=>hasRuntime(id)?runtime:undefined} as never,
    {findById:()=>({name:'Project'})} as never,{findById:()=>({branch:'main'})} as never)
  return {app,writeToTerminal,screen,renameTerminal,deleteTerminal}
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app=>app.close()))
  screens.splice(0).forEach(screen=>screen.dispose())
  vi.unstubAllEnvs()
})

describe('external terminal API', () => {
  it('requires a bearer token and disables itself without configuration', async () => {
    const {app}=await fixture()
    expect((await app.inject('/api/v1/terminals')).statusCode).toBe(401)
    expect((await app.inject({url:'/api/v1/terminals',headers:{authorization:'Bearer wrong'}})).statusCode).toBe(401)
    vi.stubEnv('WORKTREEHUB_API_TOKEN','')
    expect((await app.inject({url:'/api/v1/terminals',headers})).statusCode).toBe(503)
  })
  it('lists only running terminals and supports project and worktree filters', async () => {
    const {app}=await fixture()
    const result=await app.inject({url:'/api/v1/terminals?projectId=p1&worktreeId=w1',headers})
    expect(result.json()).toEqual({terminals:[expect.objectContaining({id:'one',projectName:'Project',branch:'main'})]})
    expect((await app.inject({url:'/api/v1/terminals?projectId=p2',headers})).json()).toEqual({terminals:[]})
  })
  it('renames a live terminal, validates titles, and requires bearer auth', async () => {
    const {app,renameTerminal,writeToTerminal}=await fixture()
    const patch=(id:string,payload:object)=>app.inject({method:'PATCH',url:'/api/v1/terminals/'+id,headers,payload})
    const renamed=await patch('one',{title:'  修复购物车  '})
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({id:'one',title:'修复购物车'})
    expect(renameTerminal).toHaveBeenCalledWith('one',{title:'修复购物车'})
    expect((await app.inject({url:'/api/v1/terminals',headers})).json().terminals[0].title).toBe('修复购物车')
    expect((await patch('one',{title:'   '})).statusCode).toBe(400)
    expect((await patch('one',{title:'a'.repeat(201)})).statusCode).toBe(400)
    expect((await patch('one',{title:'a\nb'})).statusCode).toBe(400)
    expect((await patch('one',{title:'test',id:'two'})).statusCode).toBe(400)
    expect((await patch('one',{})).statusCode).toBe(400)
    expect((await patch('two',{title:'exited'})).statusCode).toBe(404)
    expect((await patch('missing',{title:'missing'})).statusCode).toBe(404)
    expect((await app.inject({method:'PATCH',url:'/api/v1/terminals/one',payload:{title:'unauthorized'}})).statusCode).toBe(401)
    expect(renameTerminal).toHaveBeenCalledTimes(1)
    expect(writeToTerminal).not.toHaveBeenCalled()
  })
  it('closes running or exited terminals with token auth and removes them from discovery', async () => {
    const {app,deleteTerminal,writeToTerminal}=await fixture()
    const close=(id:string)=>app.inject({method:'DELETE',url:'/api/v1/terminals/'+id,headers})
    expect((await app.inject({method:'DELETE',url:'/api/v1/terminals/one'})).statusCode).toBe(401)
    expect(deleteTerminal).not.toHaveBeenCalled()
    const closed=await close('one')
    expect(closed.statusCode).toBe(204)
    expect(closed.body).toBe('')
    expect(deleteTerminal).toHaveBeenCalledWith('one')
    expect((await app.inject({url:'/api/v1/terminals',headers})).json()).toEqual({terminals:[]})
    expect((await app.inject({url:'/api/v1/terminals/one/buffer',headers})).statusCode).toBe(404)
    expect((await app.inject({method:'POST',url:'/api/v1/terminals/one/input',headers,payload:{text:'hello'}})).statusCode).toBe(404)
    expect(writeToTerminal).not.toHaveBeenCalled()
    expect((await close('two')).statusCode).toBe(204)
    expect((await close('one')).statusCode).toBe(404)
    expect((await close('missing')).statusCode).toBe(404)
    vi.stubEnv('WORKTREEHUB_API_TOKEN','')
    expect((await close('one')).statusCode).toBe(503)
  })
  it('supports raw ranges, tail, parsed screen and invalid ranges', async () => {
    const {app,screen}=await fixture()
    const get=(query:string)=>app.inject({url:'/api/v1/terminals/one/buffer?'+query,headers})
    expect((await get('format=raw&start=2&end=3')).json()).toMatchObject({start:2,end:3,totalLines:3,content:'second\r\nthird'})
    expect((await get('format=raw&tail=1')).json()).toMatchObject({content:'third'})
    expect((await get('format=raw&start=99&end=100')).json()).toMatchObject({start:null,end:null,content:''})
    await new Promise<void>(resolve=>screen.write('\r\x1b[2Kupdated',resolve))
    expect((await get('format=screen')).json().content).toContain('updated')
    expect((await get('format=screen')).json().content).not.toContain('third')
    expect((await get('tail=1&start=1&end=2')).statusCode).toBe(400)
    expect((await get('start=3&end=2')).statusCode).toBe(400)
    expect((await get('tail=0')).statusCode).toBe(400)
    expect((await app.inject({url:'/api/v1/terminals/missing/buffer',headers})).statusCode).toBe(404)
  })
  it('writes text and special keys, rejects invalid or missing targets', async () => {
    const {app,writeToTerminal}=await fixture()
    const post=(id:string,payload:object)=>app.inject({method:'POST',url:'/api/v1/terminals/'+id+'/input',headers,payload})
    expect((await post('one',{text:'hello',submit:true})).statusCode).toBe(204)
    expect(writeToTerminal).toHaveBeenLastCalledWith('one','hello\r')
    expect((await post('one',{key:'CTRL_C'})).statusCode).toBe(204)
    expect(writeToTerminal).toHaveBeenLastCalledWith('one','\x03')
    expect((await post('one',{key:'UNKNOWN'})).statusCode).toBe(400)
    expect((await post('missing',{text:'hello'})).statusCode).toBe(404)
    expect(writeToTerminal).toHaveBeenCalledTimes(2)
  })
})
