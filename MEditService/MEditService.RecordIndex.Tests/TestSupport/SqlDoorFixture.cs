using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>An index of the test plugin, of its own for each class that reads it: a class's tests share it, and the
/// filter one sets narrows every listing a parallel reader of an index shared wider would ask for.</summary>
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
