using MEditService.TestSupport;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>An index of the test plugin for one class: its tests share it, and a filter one sets would narrow the
/// listings of any other class reading it.</summary>
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
