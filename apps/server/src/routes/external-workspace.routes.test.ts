import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../utils/app-error.js'
import { registerExternalTerminalRoutes } from './external-terminal.routes.js'
import { registerExternalWorkspaceRoutes } from './external-workspace.routes.js'

const token = 'test-token-with-at-least-32-characters'
const headers = { authorization: 'Bearer ' + token }
const apps: ReturnType<typeof Fastify>[] = []

async function fixture() {
  vi.stubEnv('WORKTREEHUB_API_TOKEN', token)
  const app = Fastify()
  apps.push(app)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({error:{code:error.code,message:error.message}})
    return reply.code(500).send({error: String(error)})
  })
  const project = {id:'p1',name:'Project',mainBranch:'main'}
  const existing = {id:'w1',projectId:'p1',isArchived:false}
  const other = {id:'w2',projectId:'p2',isArchived:false}
  const archived = {id:'w3',projectId:'p1',isArchived:true}
  const created = {id:'w4',projectId:'p1',isArchived:false}
  const findById = vi.fn((id:string) => [existing,other,archived,created].find(w=>w.id===id))
  const projects = {listProjects:vi.fn(()=>[project,{id:'p2',mainBranch:'dev'}]),listBranches:vi.fn(async()=>({local:['main'],remote:['origin/main']}))}
  const worktrees = {syncProjectWorktrees:vi.fn(async()=>{}),listWorktrees:vi.fn(async()=>[existing,archived]),createWorktree:vi.fn(async()=>created)}
  const terminals = {createTerminal:vi.fn(()=>({id:'t1',projectId:'p1',worktreeId:'w4',status:'running'}))}
  await app.register(async scope => {
    await registerExternalTerminalRoutes(scope, terminals as never, {} as never, {} as never, {findById} as never)
    await registerExternalWorkspaceRoutes(scope, projects as never, worktrees as never, terminals as never, {findById} as never)
  })
  return {app,projects,worktrees,terminals}
}
afterEach(async()=>{
  await Promise.all(apps.splice(0).map(app=>app.close()))
  vi.unstubAllEnvs()
})

describe('external workspace API',()=>{
  it('requires token authentication on every new endpoint',async()=>{
    const {app,worktrees,terminals}=await fixture()
    for(const [method,url] of [
      ['GET','/api/v1/projects'],
      ['GET','/api/v1/projects/p1/worktrees'],
      ['GET','/api/v1/projects/p1/branches'],
      ['POST','/api/v1/projects/p1/worktrees'],
      ['POST','/api/v1/projects/p1/worktrees/w1/terminals'],
    ] as const) {
      expect((await app.inject({method,url})).statusCode).toBe(401)
    }
    expect(worktrees.createWorktree).not.toHaveBeenCalled()
    expect(terminals.createTerminal).not.toHaveBeenCalled()
    vi.stubEnv('WORKTREEHUB_API_TOKEN','')
    expect((await app.inject({url:'/api/v1/projects',headers})).statusCode).toBe(503)
  })
  it('discovers projects, syncs worktrees and returns branches',async()=>{
    const {app,worktrees}=await fixture()
    expect((await app.inject({url:'/api/v1/projects',headers})).json().projects[0].id).toBe('p1')
    expect((await app.inject({url:'/api/v1/projects/p1/worktrees',headers})).json().worktrees[0].id).toBe('w1')
    expect(worktrees.syncProjectWorktrees).toHaveBeenCalledWith('p1')
    expect((await app.inject({url:'/api/v1/projects/p1/branches',headers})).json()).toEqual({local:['main'],remote:['origin/main']})
    expect((await app.inject({url:'/api/v1/projects/missing/worktrees',headers})).statusCode).toBe(404)
  })
  it('creates a worktree with the project default or explicit base',async()=>{
    const {app,worktrees}=await fixture()
    const create=(payload:object)=>app.inject({method:'POST',url:'/api/v1/projects/p1/worktrees',headers,payload})
    const result=await create({branch:'feature/fix-cart'})
    expect(result.statusCode).toBe(201)
    expect(result.json().id).toBe('w4')
    expect(worktrees.createWorktree).toHaveBeenLastCalledWith('p1',{branch:'feature/fix-cart',baseRef:'main'})
    expect((await create({branch:'feature/second',baseRef:'origin/dev',name:'Second'})).statusCode).toBe(201)
    expect(worktrees.createWorktree).toHaveBeenLastCalledWith('p1',{branch:'feature/second',baseRef:'origin/dev',name:'Second'})
    for(const payload of [{branch:'../escape'},{branch:'-bad'},{branch:'bad branch'},{branch:'bad//branch'},{branch:'valid',baseRef:'--help'},{branch:'valid',path:'/tmp/outside'},{}]){
      expect((await create(payload)).statusCode).toBe(400)
    }
    expect(worktrees.createWorktree).toHaveBeenCalledTimes(2)
  })
  it('creates terminals in the requested project/worktree and rejects mismatches',async()=>{
    const {app,terminals}=await fixture()
    const create=(id:string,payload:object={})=>app.inject({method:'POST',url:'/api/v1/projects/p1/worktrees/'+id+'/terminals',headers,payload})
    const response=await create('w4',{title:'Claude Code',initialCommand:'claude',cols:120,rows:30})
    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({id:'t1',worktreeId:'w4'})
    expect(terminals.createTerminal).toHaveBeenLastCalledWith('w4',{title:'Claude Code',initialCommand:'claude',cols:120,rows:30})
    expect((await create('w1')).statusCode).toBe(201)
    expect((await create('w2')).statusCode).toBe(404)
    expect((await create('missing')).statusCode).toBe(404)
    expect((await create('w3')).statusCode).toBe(409)
    expect((await create('w1',{cols:10000})).statusCode).toBe(400)
    expect((await create('w1',{projectId:'p2'})).statusCode).toBe(400)
    expect(terminals.createTerminal).toHaveBeenCalledTimes(2)
  })
})
