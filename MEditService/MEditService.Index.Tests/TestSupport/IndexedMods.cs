using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.TestSupport;

/// <summary>Indexes a fixture mod the way the adapter's own door does: the codec turns it into
/// documents first, so a test states a plugin and the index still only ever sees text.</summary>
internal static class IndexedMods
{
    internal static void IndexMod(
        this IRecordIndex index, IModGetter mod, Registration registration, PluginKey key, string? filePath = null)
    {
        using var documents = Documents(mod);
        index.Index(documents, registration, key, filePath);
    }

    internal static IPluginDocuments Documents(IModGetter mod) =>
        ModDocuments.Of(mod, SharedSchemaReflector.Instance.GetSchemas(mod.GameRelease));
}
