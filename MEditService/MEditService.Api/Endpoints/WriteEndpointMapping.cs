using MEditService.Core.Edits;
using MEditService.Core.Records;

namespace MEditService.Api.Endpoints;

/// <summary>
/// The write handlers' shared binding and error-mapping seam — one <see cref="PluginKeyOf"/>
/// binder and, for the write path's two exception vocabularies, one mapper each
/// (<see cref="Refusal"/> for <see cref="RecordEditRefusal"/>, <see cref="WriteFailure"/> for the
/// <see cref="IOException"/>/<see cref="UnauthorizedAccessException"/> pair every write endpoint
/// treats as "the source file could not be touched"; <see cref="NoLoadOrder"/> and
/// <see cref="MalformedFormKey"/> are the two remaining exception shapes that recur verbatim across
/// several of those same handlers). Centralizes ADR-0026's `.Produces&lt;T&gt;()`/
/// `.ProducesProblem(status)` invariant to one enforcement point per shape.
///
/// <para><b>Deliberately does not log.</b> The 4xx-logs-only-via-middleware rule (root
/// <c>MEditService/CLAUDE.md</c>, Logging) means a refusal never logs here. The 500/503/400
/// mappers below don't log either: every call site keeps its own
/// <c>logger.LogError(ex, "...", ...)</c> immediately before calling one of these — the structured
/// log line differs per site (which file, which FormKey, which plugin) in a way a shared mapper
/// cannot generalize without losing that context. <see cref="Execute"/> keeps the same rule: it
/// contains no <c>Log*</c> call and builds no message text of its own — every delegate it invokes,
/// including <c>logReceived</c>, is call-site code carrying its own logging (#637: one generic
/// executor for the six write endpoints' shared skeleton, parameterized on the logging rather than
/// performing it).</para>
///
/// <para><b>Not every <c>PluginKey</c> construction routes through <see cref="PluginKeyOf"/></b> —
/// the handlers that build a <see cref="PluginKey"/> entirely from body fields (already-decoded
/// JSON strings: <c>EditField</c>, <c>DeleteRecord</c>, <c>RenumberRecord</c>,
/// <c>CopyRecordAsOverride</c>, <c>CopyRecordAsNewRecord</c>) must never pass them through
/// <see cref="Uri.UnescapeDataString"/> — a plugin name containing a literal <c>%</c> would be
/// double-unescaped. Those call sites keep their plain
/// <c>new PluginKey(request.Plugin, request.Origin)</c>. <see cref="PluginKeyOf"/> exists for the
/// handlers whose plugin name is route-bound and therefore URL-encoded (<c>CreateRecord</c>,
/// <c>PeekNextFreeFormKey</c>, <c>Compile</c>, <c>KeepExternalChange</c>).</para>
/// </summary>
internal static class WriteEndpointMapping
{
    /// <summary>Binds a route-bound plugin name (URL-encoded) and an origin into a
    /// <see cref="PluginKey"/>. Never call this with a body-sourced plugin name — see the type's own
    /// doc comment.</summary>
    internal static PluginKey PluginKeyOf(string routePlugin, string origin) =>
        new(Uri.UnescapeDataString(routePlugin), origin);

    /// <summary>
    /// A refused edit as ProblemDetails, carrying the <see cref="RecordEditRefusal"/> as a
    /// <c>refusal</c> extension beside the human-readable detail.
    /// The status code says what <i>kind</i> of problem it is, so an ordinary HTTP client
    /// behaves sanely without knowing our vocabulary; the extension says exactly which one, so an
    /// agent never has to match on prose (ADR-0026).
    ///
    /// <para>#290: <c>eslContradiction</c> rides beside it, the create-time twin of
    /// <c>CompileResult.EslContradiction</c> — true only for the one
    /// <see cref="RecordEditRefusal.FormKeySpaceExhausted"/> shape a header edit can resolve, so
    /// the frontend can offer the same accept/decline prompt compile already gives instead of
    /// leaving the refusal a dead end.</para>
    /// </summary>
    internal static IResult Refusal(RecordEditResult result) => Results.Problem(
        detail: result.Message,
        statusCode: result.Refusal switch
        {
            // Not-editable-at-all is a state conflict: the request is well-formed, and the answer is
            // "not while this plugin is untracked".
            RecordEditRefusal.PluginNotTracked or RecordEditRefusal.PluginHasNoModFolder => 409,
            RecordEditRefusal.RecordNotFound or RecordEditRefusal.FieldNotFound => 404,
            // Well-formed, addressed at something real, and still not something we will write.
            _ => 422,
        },
        extensions: new Dictionary<string, object?>
        {
            ["refusal"] = result.Refusal.ToString(),
            ["eslContradiction"] = result.EslContradiction,
        });

    /// <summary>
    /// The write path touches a file inside a live git working tree Modbench does not own
    /// exclusively (root CLAUDE.md) — it can be locked by another tool, replaced, or sitting on a
    /// mount that just went away. Every write endpoint catches <see cref="IOException"/>/
    /// <see cref="UnauthorizedAccessException"/> and shapes it here rather than letting one escape as
    /// a bodyless 500 a client cannot tell apart from the backend having died. <paramref name="detail"/>
    /// is caller-built (it names the record/plugin and embeds <c>ex.Message</c>) because that text is
    /// part of the wire body and differs per site — collapsing it to one shared message here would
    /// silently change what every client reads.
    /// </summary>
    internal static IResult WriteFailure(string detail) => Results.Problem(detail, statusCode: 500);

    /// <summary>The load order went away underneath the request — a "not right now", never a bad
    /// request.</summary>
    internal static IResult NoLoadOrder(InvalidOperationException ex) => Results.Problem(ex.Message, statusCode: 503);

    /// <summary>
    /// #673: this request waited out <see cref="IndexWriteGate.Timeout"/> for a write already in
    /// flight. 503, the same "not right now" family as <see cref="NoLoadOrder"/> above and
    /// deliberately <b>not</b> <see cref="WriteFailure"/>'s 500 — the write was never attempted, so
    /// nothing is half-applied and there is no source file whose failure to be written could be
    /// reported. A client's correct response is to retry, which a 500 would not tell it.
    ///
    /// <para>Carries a <c>writeGateTimeout</c> extension beside the human-readable detail, for the
    /// same reason <see cref="Refusal"/> carries <c>refusal</c> (ADR-0026): the status code tells an
    /// ordinary HTTP client what kind of problem this is, and the extension tells an agent exactly
    /// which one without matching on prose — 503 alone cannot be told apart from
    /// <see cref="NoLoadOrder"/>, and the two want opposite handling (retry versus reload).</para>
    /// </summary>
    internal static IResult WriteGateBusy(IndexWriteGateTimeoutException ex) => Results.Problem(
        detail: ex.Message,
        statusCode: 503,
        extensions: new Dictionary<string, object?> { ["writeGateTimeout"] = true });

    /// <summary>
    /// xEdit's own typed-FormID path reaches Mutagen's <c>FormKey.Factory</c>
    /// (<c>RecordEditService.RefuseIfNotNativeTarget</c>) with no <c>TryFactory</c> guard — a
    /// malformed value (wrong shape, non-hex, missing <c>:</c>) throws <see cref="ArgumentException"/>
    /// there. Malformed syntax, not a well-formed-but-refused <see cref="RecordEditRefusal"/>, so this
    /// is <c>PluginEndpoints.CreatePlugin</c>'s own catch shape (400), never <see cref="Refusal"/>'s
    /// 422.
    /// </summary>
    internal static IResult MalformedFormKey(ArgumentException ex) => Results.Problem(ex.Message, statusCode: 400);

    /// <summary>
    /// The six write endpoints' shared skeleton (#637): decode → guarded reception log → 400
    /// validation → try the service call → map <c>Applied</c>/<see cref="Refusal"/>, catching the
    /// same three exception shapes in the same order every site already used. Every parameter is a
    /// call-site delegate; this method sequences them and touches no request/response field itself.
    ///
    /// <para><paramref name="logReceived"/> is <c>null</c> at <c>PluginEndpoints.CreateRecord</c>
    /// only — not an oversight: every <c>PluginEndpoints</c> handler had its own "Received ..." line
    /// deliberately removed as redundant with <c>UseSerilogRequestLogging</c>'s per-request summary
    /// (see <c>EndpointReceptionLoggingTests</c>'s header comment, the one place that decision is
    /// recorded). <c>RecordEndpoints</c>' five handlers still log on entry, so they each pass a
    /// non-null delegate.</para>
    ///
    /// <para><paramref name="onMalformedFormKey"/> is non-null only at the three sites that accept a
    /// caller-typed target FormKey reaching Mutagen's <c>FormKey.Factory</c> with no
    /// <c>TryFactory</c> guard (<c>RenumberRecord</c>'s <c>NewFormKey</c>, <c>CopyRecordAsNewRecord</c>'s
    /// <c>RequestedFormKey</c>, <c>CreateRecord</c>'s <c>FormKey</c>) — the other three build every
    /// <see cref="PluginKey"/> from plain strings, which cannot throw <see cref="ArgumentException"/>,
    /// so leaving it <c>null</c> there reproduces letting that exception type propagate unhandled,
    /// exactly as those three sites do today.</para>
    /// </summary>
    /// <para>#673: <paramref name="gate"/> is taken around <paramref name="execute"/> and nothing
    /// else. Validation and the reception log run before it, so a malformed request is answered
    /// without ever queueing; <paramref name="onApplied"/> and every error mapper run after it, so a
    /// response is shaped while the next write is already free to start. Taking it here rather than
    /// inside each service is what makes "one write at a time" a property of the write <i>path</i>
    /// rather than of six independent remembering-to.</para>
    internal static IResult Execute(
        IndexWriteGate gate,
        Action? logReceived,
        Func<IResult?> validate,
        Func<RecordEditResult> execute,
        Func<RecordEditResult, IResult> onApplied,
        Func<Exception, IResult> onWriteFailure,
        Func<ArgumentException, IResult>? onMalformedFormKey,
        Func<InvalidOperationException, IResult> onNoLoadOrder)
    {
        logReceived?.Invoke();

        if (validate() is { } validationFailure)
            return validationFailure;

        try
        {
            RecordEditResult result;
            using (gate.Enter()) result = execute();
            return result.Applied ? onApplied(result) : Refusal(result);
        }
        catch (IndexWriteGateTimeoutException ex)
        {
            // Before the general catches below, and above all before the InvalidOperationException
            // one: a nested BeginTransaction on the shared connection throws exactly that type
            // ("Already in a transaction." — DuckDbConnectionIsolationTests), so an unserialized
            // collision used to reach the client as a 503 claiming the load order had gone away.
            // This is the honest answer to the same situation, and the gate is what makes it
            // reachable instead.
            return WriteGateBusy(ex);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return onWriteFailure(ex);
        }
        catch (ArgumentException ex) when (onMalformedFormKey is not null)
        {
            return onMalformedFormKey(ex);
        }
        catch (InvalidOperationException ex)
        {
            return onNoLoadOrder(ex);
        }
    }
}
