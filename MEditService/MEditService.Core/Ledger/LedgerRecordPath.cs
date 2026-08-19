using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Ledger;

/// <summary>A record's identity as recovered from its own ledger path — the inverse of
/// <see cref="LedgerRecordPath.For"/>.</summary>
internal sealed record LedgerRecordIdentity(string PluginFileName, string RecordType, string FormKey);

/// <summary>
/// The ledger's own file layout policy: one record, one file, always — including a container
/// record's own (shallow) file, per <see cref="ContainerStripFields"/>. Flat, not nested under a
/// parent's own path:
/// <c>&lt;pluginFileName&gt;.ledger/&lt;recordType&gt;/&lt;originModKey&gt;/&lt;localFormID
/// hex6&gt;.json</c>, relative to the origin folder (the ledger's working tree).
///
/// Two path segments are load-bearing, not decoration:
/// - The <c>.ledger</c> suffix on the first segment: the working tree *is* the origin folder,
///   which already contains the plugin binary itself at literally <c>&lt;pluginFileName&gt;</c> —
///   a bare <c>pluginFileName/</c> directory would collide with that file (confirmed:
///   <c>Directory.CreateDirectory</c> throws <see cref="DirectoryNotFoundException"/> when an
///   ancestor segment is an existing file, not a missing directory).
/// - The <c>&lt;originModKey&gt;</c> segment (the record's *origin* plugin — <c>FormKey.ModKey</c>
///   — never the plugin the record is written into, which is <paramref name="pluginFileName"/> and can
///   legitimately differ, e.g. an override edited through a patch plugin): a FormKey's local ID is
///   only unique within its own origin ModKey, not globally, so two records from *different*
///   masters sharing a local ID and written into the same target plugin would otherwise collide on
///   one path and silently clobber each other's baseline and history — confirmed as a real defect
///   (review, #370) before this segment existed. <c>RecordQueryService.GetRecordForPlugin</c>
///   exists precisely because "held by a plugin that isn't the record's origin" is routine, not
///   an edge case, so this can't be assumed away.
///
/// A child record's placement inside its parent (e.g. a placed ref's parent cell) is not encoded
/// in this path — nothing in #370 vendors a placed child yet (that's #373's write shape), so there
/// is no containment relationship to encode here today; a future ticket that does can revisit the
/// layout without this one's own paths moving.
/// </summary>
internal static class LedgerRecordPath
{
    internal const string LedgerSuffix = ".ledger";
    private const string JsonSuffix = ".json";

    internal static string For(string pluginFileName, string recordType, string formKeyString)
    {
        var formKey = FormKey.Factory(formKeyString);
        return Path.Combine($"{pluginFileName}.ledger", recordType, formKey.ModKey.FileName.String, $"{formKey.ID:X6}.json");
    }

    /// <summary>Recovers a record's identity straight from its own path text — no JSON parse, no
    /// git read (#368: a status listing needs to name every changed record, not read its content).
    /// Lossless by construction: every segment <see cref="For"/> writes is exactly what this reads
    /// back, and a FormKey's wire format (<c>&lt;hex6&gt;:&lt;ModKeyFileName&gt;</c>) is assembled
    /// from the same two path segments <see cref="For"/> derived it from. Fails closed (returns
    /// <see langword="false"/>) on anything not shaped like a path this layout could have produced —
    /// git status scoped to <c>*.ledger/*</c> (<see cref="LedgerRepository.WorkingTreeStatus"/>)
    /// should never hand this a non-conforming path, but a caller must not silently misreport one
    /// as belonging to a record it doesn't.</summary>
    internal static bool TryParse(string relativePath, out LedgerRecordIdentity identity)
    {
        identity = null!;
        var segments = relativePath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length != 4) return false;

        var (pluginSegment, recordType, originModKey, fileSegment) = (segments[0], segments[1], segments[2], segments[3]);
        if (!pluginSegment.EndsWith(LedgerSuffix, StringComparison.Ordinal)) return false;
        if (!fileSegment.EndsWith(JsonSuffix, StringComparison.Ordinal)) return false;

        var pluginFileName = pluginSegment[..^LedgerSuffix.Length];
        var localId = fileSegment[..^JsonSuffix.Length];
        // No originModKey.Length == 0 check: RemoveEmptyEntries above already guarantees every
        // segment (this one included) is non-empty — provably unreachable, not merely untested
        // (mutation review, #368), so it isn't pinned in place with a test that can never fail it.
        if (pluginFileName.Length == 0 || localId.Length == 0) return false;

        identity = new LedgerRecordIdentity(pluginFileName, recordType, $"{localId}:{originModKey}");
        return true;
    }
}
