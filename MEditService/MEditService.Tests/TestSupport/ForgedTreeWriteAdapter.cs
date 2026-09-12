using MEditService.Core.PluginAdapter;
using MEditService.Core.Source;

namespace MEditService.Tests.TestSupport;

/// <summary>The adapter with the tree write's deserialize replaced, which is how the round-trip
/// gate's negative tests forge a codec defect no real codec has.</summary>
internal sealed class ForgedTreeWriteAdapter(TreeDeserializer deserialize) : ReadOnlyPluginAdapter
{
    public override Task WriteFromTreeAsync(
        IReadOnlyList<PristineFile> files, string destinationPath, CancellationToken cancel = default) =>
        PluginTrees.WriteFromTreeAsync(files, destinationPath, deserialize, cancel);
}
