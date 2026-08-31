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
/// cannot generalize without losing that context.</para>
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
        extensions: new Dictionary<string, object?> { ["refusal"] = result.Refusal.ToString() });

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
    /// xEdit's own typed-FormID path reaches Mutagen's <c>FormKey.Factory</c>
    /// (<c>RecordEditService.RefuseIfNotNativeTarget</c>) with no <c>TryFactory</c> guard — a
    /// malformed value (wrong shape, non-hex, missing <c>:</c>) throws <see cref="ArgumentException"/>
    /// there. Malformed syntax, not a well-formed-but-refused <see cref="RecordEditRefusal"/>, so this
    /// is <c>PluginEndpoints.CreatePlugin</c>'s own catch shape (400), never <see cref="Refusal"/>'s
    /// 422.
    /// </summary>
    internal static IResult MalformedFormKey(ArgumentException ex) => Results.Problem(ex.Message, statusCode: 400);
}
