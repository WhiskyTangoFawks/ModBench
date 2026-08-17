using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Ledger;

/// <summary>
/// The ledger's own file layout policy: one record, one file, always — including a container
/// record's own (shallow) file, per <see cref="ContainerStripFields"/>. Flat, not nested under a
/// parent's own path:
/// <c>&lt;pluginFileName&gt;.ledger/&lt;recordType&gt;/&lt;localFormID hex6&gt;.yaml</c>, relative
/// to the mod folder (the ledger's working tree). The <c>.ledger</c> suffix on the first path
/// segment is load-bearing, not decoration: the working tree *is* the mod folder, which already
/// contains the plugin binary itself at literally <c>&lt;pluginFileName&gt;</c> — a bare
/// <c>pluginFileName/</c> directory would collide with that file (confirmed: <c>Directory
/// .CreateDirectory</c> throws <see cref="DirectoryNotFoundException"/> when an ancestor segment is
/// an existing file, not a missing directory). A child record's placement inside its parent (e.g. a
/// placed ref's parent cell) is not encoded in this path — nothing in #370 vendors a placed child
/// yet (that's #373's write shape), so there is no containment relationship to encode here today; a
/// future ticket that does can revisit the layout without this one's own paths moving.
/// </summary>
internal static class LedgerRecordPath
{
    internal static string For(string pluginFileName, string recordType, string formKeyString)
    {
        var formKey = FormKey.Factory(formKeyString);
        return Path.Combine($"{pluginFileName}.ledger", recordType, $"{formKey.ID:X6}.yaml");
    }
}
