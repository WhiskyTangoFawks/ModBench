using MEditService.Core.PluginAdapter;

namespace MEditService.Tests.TestSupport;

/// <summary>The adapter with the tree write's deserialize replaced, which is how the round-trip
/// gate's negative tests forge a codec defect no real codec has.</summary>
internal sealed class ForgedTreeWriteAdapter(TreeDeserializer deserialize) : ReadOnlyPluginAdapter
{
    public override Task WriteFromTreeAsync(
        string treeRoot, string destinationPath, CancellationToken cancel = default) =>
        PluginTrees.WriteFromTreeAsync(treeRoot, destinationPath, deserialize, cancel);
}
