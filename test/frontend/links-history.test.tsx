import { useState } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeLink, safeHttpUrl } from '../../frontend/src/components/SafeLink';
import { PlannedSessionModal } from '../../frontend/src/features/plan/PlannedSessionModal';
import { TrainingLog } from '../../frontend/src/features/log/TrainingLog';
import { api, ApiError, type TrackerPayload, type TrainingSession } from '../../frontend/src/api';

const qc = () => new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('accepts relative and absolute file paths; rejects same-origin nonfiles and unsafe or malformed URLs', () => {
 const origin=window.location.origin;
 for(const value of ['/api/plan/attachments/7/file','api/plan/attachments/7/file',origin+'/api/plan/attachments/7/file']) expect(safeHttpUrl(value)).toBe(origin+'/api/plan/attachments/7/file');
 for(const value of ['/api/tracker',origin+'/api/tracker','/api/plan/attachmentsx/7/file','javascript:alert(1)','data:text/plain,hi','http://[bad','',null,undefined]) expect(safeHttpUrl(value)).toBeNull();
 for(const value of ['https://example.com/x','http://example.com/x']) expect(safeHttpUrl(value)).toBe(value);
});
it('same-origin files have a plain link and external links have safe new-tab attributes', () => {
 render(<><SafeLink url='/api/plan/attachments/7/file'>file</SafeLink><SafeLink url='https://example.com/x'>external</SafeLink></>);
 const file=screen.getByRole('link',{name:'file'}); expect(file.getAttribute('target')).toBeNull(); expect(file.getAttribute('rel')).toBeNull();
 const external=screen.getByRole('link',{name:'external'}); expect(external.getAttribute('target')).toBe('_blank'); expect(external.getAttribute('rel')).toBe('noopener noreferrer');
});
it('renders Open for an uploaded file in the actual plan modal', () => {
 render(<QueryClientProvider client={qc()}><PlannedSessionModal onClose={()=>{}} onSaved={()=>{}} session={{dayKey:'mon',day:'Monday',short:'Mon',sessionType:'Practice',detail:'Technique practice',prescription:'Choose a focus',updatedAt:null,attachments:[{id:7,dayKey:'mon',kind:'document',label:'test.pdf',url:'/api/plan/attachments/7/file',mimeType:'application/pdf',createdAt:'2026-09-27T00:00:00.000Z'}]}}/></QueryClientProvider>);
 expect(screen.getByRole('link',{name:'Open'}).getAttribute('href')).toBe(window.location.origin+'/api/plan/attachments/7/file');
});
const session=(id:number, old=false):TrainingSession=>({id,sessionDate:old?'2026-09-26':'2026-09-27',sessionType:'Range',customActivity:'',arrows:1,durationMinutes:1,focus:'',score:'',notes:old?'old row sentinel':'',createdAt:'2026-09-27T00:00:00.000Z'});
const base:TrackerPayload={state:{currentCycle:1,currentWeek:1,currentPoundage:null},weeklyPlans:[],plannedSessions:[],sessions:Array.from({length:100},(_,i)=>session(200-i)),practiceScores:[],currentWeeklyNote:{id:null,weekStart:'2026-09-28',notes:'',updatedAt:null},historicalWeeklyNotes:[],weeklyArrows:[],cycleSummaries:[],milestoneChecks:{},maintenanceChecks:{},maintenanceItems:[],setups:[],inspiration:null,recipes:[]};
it.each([200,404])('removes loaded older row after delete status %s and unchanged first-page refetch', async (status) => {
 const paged=vi.spyOn(api,'getTracker').mockResolvedValue({...base,sessions:[session(100,true)]});
 const remove=vi.spyOn(api,'deleteSession');
 if(status===200) remove.mockResolvedValue({ok:true}); else remove.mockRejectedValue(new ApiError(404,'Session not found'));
 const saved=vi.fn();
 function Harness(){const [version,setVersion]=useState(0);return <><span data-testid='version'>{version}</span><TrainingLog data={{...base,sessions:[...base.sessions]}} onSaved={()=>{saved();setVersion(v=>v+1);}}/></>}
 render(<QueryClientProvider client={qc()}><Harness/></QueryClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Load older sessions'}));
 await screen.findByText('old row sentinel');
 expect(paged.mock.calls[0]?.[0].before).toBe('2026-09-27,101');
 fireEvent.click(screen.getByRole('button',{name:"Delete Range session from Sep 26, 2026"}));
 await waitFor(()=>expect(saved).toHaveBeenCalledTimes(1));
 expect(screen.getByTestId('version').textContent).toBe('1');
 expect(screen.queryAllByText('old row sentinel').length).toBe(0);
});

it('discards an edited older page and reloads the saved notes', async () => {
  const old = session(100, true);
  const get = vi.spyOn(api, 'getTracker').mockResolvedValueOnce({ ...base, sessions: [old] })
    .mockResolvedValue({ ...base, sessions: [{ ...old, notes: 'updated notes' }] });
  const update = vi.spyOn(api, 'updateSession').mockResolvedValue({ ok: true });
  const saved = vi.fn();
  render(<QueryClientProvider client={qc()}><TrainingLog data={base} onSaved={saved} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  await screen.findByText('old row sentinel');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Range session from Sep 26, 2026' }));
  fireEvent.change(screen.getByLabelText('Edit session notes'), { target: { value: 'updated notes' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 100, notes: 'updated notes' }));
  expect(screen.queryByText('old row sentinel')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  await screen.findByText('updated notes');
  expect(get).toHaveBeenCalledTimes(2);
});

it('ignores an older-page response that finishes after an identical first-page refresh', async () => {
  let resolvePage!: (page: TrackerPayload) => void;
  const response = new Promise<TrackerPayload>(resolve => { resolvePage = resolve; });
  const get = vi.spyOn(api, 'getTracker').mockReturnValue(response);
  const client = qc();
  const view = (version: number) => <QueryClientProvider client={client}><TrainingLog data={base} historyVersion={version} onSaved={() => {}} /></QueryClientProvider>;
  const { rerender } = render(view(1));
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
  rerender(view(2));
  resolvePage({ ...base, sessions: [session(100, true)] });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load older sessions' })).toBeTruthy());
  expect(screen.queryByText('old row sentinel')).toBeNull();
});

it('drops already-loaded older pages on a refresh even when the data object is shared', async () => {
  vi.spyOn(api, 'getTracker').mockResolvedValue({ ...base, sessions: [session(100, true)] });
  const client = qc();
  const view = (version: number) => <QueryClientProvider client={client}><TrainingLog data={base} historyVersion={version} onSaved={() => {}} /></QueryClientProvider>;
  const { rerender } = render(view(1));
  fireEvent.click(screen.getByRole('button', { name: 'Load older sessions' }));
  await screen.findByText('old row sentinel');
  rerender(view(2));
  expect(screen.queryByText('old row sentinel')).toBeNull();
});

it('disables deletion while pending, preventing a second click from sending another request', async () => {
  let resolveDelete!: (value: { ok: true }) => void;
  const remove = vi.spyOn(api, 'deleteSession').mockReturnValue(new Promise(resolve => { resolveDelete = resolve; }));
  const saved = vi.fn();
  render(<QueryClientProvider client={qc()}><TrainingLog data={{ ...base, sessions: [session(100, true)] }} onSaved={saved} /></QueryClientProvider>);
  const button = screen.getByRole('button', { name: 'Delete Range session from Sep 26, 2026' }) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() => expect(button.disabled).toBe(true));
  fireEvent.click(button);
  expect(remove).toHaveBeenCalledTimes(1);
  resolveDelete({ ok: true });
  await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
});
