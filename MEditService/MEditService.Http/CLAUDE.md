# MEditService.Http

HTTP endpoints. mEdit's front door and composition root: it builds every box and starts the Mod
watcher. One endpoint per Commands handler and per Queries read, plus the notification stream, the
SSE adapter of the notification port. An endpoint binds the request, calls its one handler or read,
and maps the answer or typed refusal to a status; it never calls the record index or an adapter
itself.

```bash
dotnet run --project MEditService.Http   # localhost:5172, /swagger
```
