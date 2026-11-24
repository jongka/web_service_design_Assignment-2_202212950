# 증거 캡처 도구

`evidence/`의 화면 캡처(T01~T32, U01~U05)와 테스트 출력(TEST-*)을 다시 만듭니다. 과제 서비스 코드와 별개이며 `starter`의 의존성을 바꾸지 않습니다.

- `capture.js`: 시나리오마다 임시 폴더의 새 SQLite 파일로 `starter/src/server.js`를 `PORT=3100`에서 실행하고, Chrome으로 실제 화면을 조작해 `evidence/<ID>-*.png`를 저장합니다. 캡처 시점의 응답 코드·알림·목록 상태는 `shots.json`에 기록됩니다. `data/app.sqlite`는 사용하지 않습니다.
- `testout.js`: `npm test`, `test:assignment`, `test:advanced`와 같은 테스트 파일을 `node --test --test-reporter=tap`으로 실행해 출력을 `evidence/TEST-*.txt`와 `.png`로 저장합니다.

```sh
cd evidence/tools
npm install
node capture.js            # 전체 시나리오
node capture.js T29 U04    # 일부만
node testout.js
```

설치된 Chrome을 사용합니다. 경로가 다르면 `CHROME_PATH` 환경변수로 지정하세요. T18·T19는 신청 시각을, T28~T30은 실패 트리거를 테스트와 같은 SQL로 실행 중인 DB에 직접 적용합니다.
