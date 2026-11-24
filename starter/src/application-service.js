import { AppError, missing, forbidden, invalidState } from './errors.js';

// 업무 규칙과 트랜잭션. 모든 변경 요청은 tx() 안에서 최신 DB 상태를 다시 읽고 검사한 뒤 저장합니다.
// 검사 순서: 대상 존재(404) → 권한(403) → 현재 상태(409) → 정원(409).
export function createApplicationService(repo) {
  // BEGIN IMMEDIATE: 검사 전에 쓰기 잠금을 잡아 다른 프로세스가 검사~저장 사이에 끼어들지 못하게 합니다.
  // 콜백에서 예외(거부·저장 오류)가 나면 ROLLBACK 후 다시 던져 상태·이력 모두 요청 전으로 되돌립니다.
  function tx(work) {
    repo.db.exec('BEGIN IMMEDIATE');
    try { const result=work(); repo.db.exec('COMMIT'); return result; }
    catch(e) { repo.db.exec('ROLLBACK'); throw e; }
  }
  // 신청 조회 + 담당 운영자 권한 확인 (approve·revoke 공통)
  function managedApplication(actor,applicationId) {
    const a=repo.application(applicationId); if(!a) throw missing('신청');
    if(actor.role!=='MANAGER'||repo.event(a.eventId).managerId!==actor.id) throw forbidden();
    return a;
  }
  // 같은 행사 PENDING 중 created_at ASC, id ASC 첫 한 명 (자동 승급 대상)
  function nextWaiting(eventId) {
    return repo.db.prepare("SELECT id FROM applications WHERE event_id=? AND status='PENDING' ORDER BY created_at ASC, id ASC LIMIT 1").get(eventId);
  }
  return {
    apply(actor,eventId) {
      return tx(()=>{
        if(!repo.event(eventId)) throw missing('행사');
        if(actor.role!=='STUDENT') throw forbidden();
        // CANCELLED·REVOKED 기록도 남아 있으므로 상태와 무관하게 기존 행이 있으면 중복입니다.
        if(repo.existing(eventId,actor.id)) throw new AppError(409,'ALREADY_APPLIED','이미 신청한 행사입니다.');
        const a=repo.insert(eventId,actor.id);
        repo.addHistory({applicationId:a.id,actorId:actor.id,action:'APPLY',toStatus:'PENDING'});
        return a;
      });
    },
    cancel(actor,applicationId) {
      return tx(()=>{
        const a=repo.application(applicationId); if(!a) throw missing('신청');
        if(actor.role!=='STUDENT'||a.userId!==actor.id) throw forbidden();
        if(a.status!=='PENDING') throw invalidState();
        const updated=repo.setStatus(a.id,'CANCELLED');
        repo.addHistory({applicationId:a.id,actorId:actor.id,action:'CANCEL',fromStatus:'PENDING',toStatus:'CANCELLED'});
        return updated; // 대기 취소는 승인 자리를 비우지 않으므로 자동 승급 없음
      });
    },
    approve(actor,applicationId) {
      return tx(()=>{
        const a=managedApplication(actor,applicationId);
        if(a.status!=='PENDING') throw invalidState();
        if(repo.approvedCount(a.eventId)>=repo.event(a.eventId).capacity) throw new AppError(409,'CAPACITY_FULL','정원이 가득 찼습니다.');
        const updated=repo.setStatus(a.id,'APPROVED');
        repo.addHistory({applicationId:a.id,actorId:actor.id,action:'APPROVE',fromStatus:'PENDING',toStatus:'APPROVED'});
        return updated;
      });
    },
    revoke(actor,applicationId,reason) {
      return tx(()=>{
        const a=managedApplication(actor,applicationId);
        if(a.status!=='APPROVED') throw invalidState();
        const revoked=repo.setStatus(a.id,'REVOKED');
        const causeHistoryId=repo.addHistory({applicationId:a.id,actorId:actor.id,action:'REVOKE',fromStatus:'APPROVED',toStatus:'REVOKED',reason});
        // 요청당 최대 한 명만 승급합니다. 대기자가 없으면 자리를 비워 둡니다.
        const next=nextWaiting(a.eventId);
        if(!next) return {revoked,promoted:null};
        const promoted=repo.setStatus(next.id,'APPROVED');
        repo.addHistory({applicationId:next.id,actorId:actor.id,action:'AUTO_APPROVE',fromStatus:'PENDING',toStatus:'APPROVED',causeHistoryId});
        return {revoked,promoted};
      });
    }
  };
}
