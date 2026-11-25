using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>An index of its own for a class that sets the filter, which narrows every listing a
/// parallel reader of a shared index asks for. What a filter may name is the schema's.</summary>
public sealed class SqlDoorFixture : IDisposable
{
    internal TestPluginFixture Plugin { get; } = new();

    internal OpenedIndex Index { get; }

    public SqlDoorFixture() => Index = Indexes.Reconciled(Plugin.DataFolder, Plugin.Plugins);

    public void Dispose()
    {
        Index.Dispose();
        Plugin.Dispose();
    }
}
