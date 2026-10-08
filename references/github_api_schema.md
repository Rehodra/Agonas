# GitHub API usage

| Purpose | Endpoint |
|---|---|
| Issue | `GET /repos/{o}/{r}/issues/{n}` |
| Comments | `GET /repos/{o}/{r}/issues/{n}/comments?per_page=100` |
| Candidate repos | `GET /users/{u}/repos?sort=updated&per_page=10` |
| Same-repo load | `GET /search/issues?q=repo:{o}/{r} is:issue is:open assignee:{u}` |
| Global load | `GET /search/issues?q=is:issue is:open assignee:{u}` |
| Lifetime merged PRs | `GET /search/issues?q=is:pr is:merged author:{u}` |
| Caller permission | `GET /repos/{o}/{r}` → `permissions` |
| Assign | `POST /repos/{o}/{r}/issues/{n}/assignees` body `{"assignees":[u]}` |

Rate limits: the search API allows 30 requests/min when authenticated. The scripts sleep and retry
once on 403/429 using `Retry-After` / `X-RateLimit-Reset` (capped at 60s) and then fail with a clear message.
