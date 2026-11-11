using System.Text;
using System.Text.Json;
using MEditService.RecordIndex.Queries;

namespace MEditService.Http.Endpoints;

/// <summary>A SELECT's rows as newline-delimited JSON, each written as it is read: a line per row, then a last line that
/// ends them or carries the refusal that stopped them.</summary>
internal sealed class SelectedRowLines(SelectedRows rows) : IResult
{
    internal const string ContentType = "application/x-ndjson";

    // Kestrel holds what is written until a flush, and a flush waits while the client reads slower.
    private const long FlushBytes = 64 * 1024;

    public async Task ExecuteAsync(HttpContext httpContext)
    {
        using (rows)
        {
            var aborted = httpContext.RequestAborted;
            var writer = httpContext.Response.BodyWriter;
            httpContext.Response.ContentType = ContentType;
            long unflushed = 0;
            foreach (var line in rows.Rows())
            {
                if (!line.Holds(out var row, out var refused))
                {
                    Logged(httpContext, refused);
                    Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { refusal = refused.Refusal.ToString(), detail = refused.Message }) + "\n", writer);
                    return;
                }
                unflushed += Encoding.UTF8.GetBytes($"{{\"row\":{row}}}\n", writer);
                if (unflushed < FlushBytes) continue;
                await writer.FlushAsync(aborted);
                unflushed = 0;
            }
            Encoding.UTF8.GetBytes("{\"end\":true}\n", writer);
        }
    }

    private static void Logged(HttpContext httpContext, IndexRefused refused) =>
        httpContext.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(SelectedRowLines))
            .LogWarning("{Method} {Path} stopped: {Refusal} — {Message}", httpContext.Request.Method, httpContext.Request.Path, refused.Refusal, refused.Message);
}
