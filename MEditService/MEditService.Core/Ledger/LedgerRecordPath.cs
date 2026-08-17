using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Ledger;

/// <summary>
/// The ledger's own file layout policy: one record, one file, always — including a container
/// record's own (shallow) file, per <see cref="ContainerStripFields"/>. Flat, not nested under a
/// parent's own path:
/// <c>&lt;pluginFileName&gt;.ledger/&lt;recordType&gt;/&lt;originModKey&gt;/&lt;localFormID
/// hex6&gt;.yaml</c>, relative to the origin folder (the ledger's working tree).
///
/// Two path segments are load-bearing, not decoration:
/// - The <c>.ledger</c> suffix on the first segment: the working tree *is* the origin folder,
///   which already contains the plugin binary itself at literally <c>&lt;pluginFileName&gt;</c> —
///   a bare <c>pluginFileName/</c> directory would collide with that file (confirmed:
///   <c>Directory.CreateDirectory</c> throws <see cref="DirectoryNotFoundException"/> when an
///   ancestor segment is an existing file, not a missing directory).
/// - The <c>&lt;originModKey&gt;</c> segment (the record's *origin* plugin — <c>FormKey.ModKey</c>
///   — never the plugin the edit is staged onto, which is <paramref name="pluginFileName"/> and can
///   legitimately differ, e.g. an override edited through a patch plugin): a FormKey's local ID is
///   only unique within its own origin ModKey, not globally, so two records from *different*
///   masters sharing a local ID and staged into the same target plugin would otherwise collide on
///   one path and silently clobber each other's baseline and history — confirmed as a real defect
///   (review, #370) before this segment existed. <c>RecordQueryService.GetRecordForPlugin</c>
///   exists precisely because "staged onto a plugin that isn't the record's origin" is routine, not
///   an edge case, so this can't be assumed away.
///
/// A child record's placement inside its parent (e.g. a placed ref's parent cell) is not encoded
/// in this path — nothing in #370 vendors a placed child yet (that's #373's write shape), so there
/// is no containment relationship to encode here today; a future ticket that does can revisit the
/// layout without this one's own paths moving.
/// </summary>
internal static class LedgerRecordPath
{
    internal static string For(string pluginFileName, string recordType, string formKeyString)
    {
        var formKey = FormKey.Factory(formKeyString);
        return Path.Combine($"{pluginFileName}.ledger", recordType, formKey.ModKey.FileName.String, $"{formKey.ID:X6}.yaml");
    }
}
