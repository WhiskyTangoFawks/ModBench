using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.RecordIndex.Tests.TestSupport.Announcements;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class CompiledHeaderFollowsFileTests : IDisposable
{
    private const string Built = "Built.esp";
    private const string Bystander = "Bystander.esp";
    private const string Master = "Base.esm";
    private static readonly TimeSpan Generous = TimeSpan.FromSeconds(30);

    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _built;
    private readonly LoadOrderEntry _bystander;
    private readonly OpenedIndex _index;

    public CompiledHeaderFollowsFileTests()
    {
        _fixture = new PluginFixtureBuilder("compiled-header-follows-file")
            .WithPlugin(Master, mod => mod.Npcs.AddNew("BaseNpc"), origin: "BaseMod")
            .WithPlugin(Built, mod => mod.Npcs.AddNew("BuiltNpc"), origin: "SourceMod")
            .WithPlugin(Bystander, mod => mod.Npcs.AddNew("BystanderNpc"), origin: "BystanderMod")
            .BuildScattered();
        _built = _fixture.Plugins.Single(p => p.Name == Built);
        _bystander = _fixture.Plugins.Single(p => p.Name == Bystander);
        SourceMods.Init(_built);
        _index = Indexes.Open(_holder, notifications: _notifications);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IReadOnlyList<string>? MastersOfBuilt() =>
        _index.Queries.GetPlugins().Value().SingleOrDefault(p => p.Name == Built)?.Masters;

    private void WriteBuilt(bool referencingMaster) =>
        PluginBinaries.Rewrite(_built.Path, mod =>
        {
            if (referencingMaster) mod.Npcs.Add(new Npc(FormKey.Factory($"000800:{Master}"), Fallout4Release.Fallout4));
            mod.Npcs.AddNew("BuiltNpc");
        });

    private void ReadWrittenBuilt(IReadOnlyList<string> masters)
    {
        _index.SignalChange([_built.Key]);
        Waits.Reached(() => MastersOfBuilt()?.SequenceEqual(masters) == true, $"the masters [{string.Join(", ", masters)}]");
    }

    private IReadOnlyList<INotification> SignalNamingBuiltAndTheBystanderUntilTheBystanderIsRead()
    {
        PluginBinaries.Touch(_bystander.Path);
        var before = _notifications.Notifications.Count;
        _index.SignalChange([_built.Key, _bystander.Key]);
        Waits.Reached(() => _notifications.Since(before).Any(n => PluginChanged(_bystander)(n)), "the bystander's re-read");
        return [.. _notifications.Since(before)];
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ABuild_IsReadBeforeTheReadOfItsWriteIsVouched_WhetherItAddsAMasterOrDropsOne(bool dropsMaster)
    {
        if (dropsMaster)
        {
            WriteBuilt(referencingMaster: true);
            ReadWrittenBuilt([Master]);
        }
        WriteBuilt(referencingMaster: !dropsMaster);
        _holder.SourceWritten([_built.Key]);
        var read = Task.Run(MastersOfBuilt);

        _index.SignalChange([_built.Key]);

        Assert.Equal(dropsMaster ? [] : [Master], await read.WaitAsync(Generous));
    }

    [Fact]
    public void ACompiledFileRewrittenOutsideModbench_ReachesItsMasters()
    {
        WriteBuilt(referencingMaster: true);

        ReadWrittenBuilt([Master]);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ACompiledFileThatIsGoneOrUnreadable_LeavesItsPluginListedWithTheMastersLastRead(bool gone)
    {
        WriteBuilt(referencingMaster: true);
        ReadWrittenBuilt([Master]);
        if (gone) File.Delete(_built.Path);
        else File.WriteAllText(_built.Path, "not a plugin");

        SignalNamingBuiltAndTheBystanderUntilTheBystanderIsRead();

        Assert.Equal([Master], MastersOfBuilt());
    }

    [Fact]
    public void AHeaderThatChanged_AnnouncesItsPluginChanged()
    {
        WriteBuilt(referencingMaster: true);
        var before = _notifications.Notifications.Count;

        _index.SignalChange([_built.Key]);

        Waits.Reached(() => _notifications.Since(before).Any(n => PluginChanged(_built)(n)), "the built plugin's announcement");
    }

    [Fact]
    public void AHeaderThatReadsTheSame_AnnouncesNothingOfItsPlugin()
    {
        WriteBuilt(referencingMaster: false);

        var announced = SignalNamingBuiltAndTheBystanderUntilTheBystanderIsRead();

        Assert.DoesNotContain(announced, n => PluginChanged(_built)(n));
    }
}
