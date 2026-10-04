using MEditService.TestSupport;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>An index of its own for a class that sets the filter, which narrows every listing a
/// parallel reader of a shared index asks for. What a filter may name is the schema's.</summary>
public sealed class SqlDoorFixture : IDisposable
{
    private readonly TestPluginFixture _plugin = new();

    internal OpenedIndex Index { get; }

    public SqlDoorFixture() => Index = Indexes.Reconciled(_plugin.DataFolder, _plugin.Plugins);

    public void Dispose()
    {
        Index.Dispose();
        _plugin.Dispose();
    }
}
