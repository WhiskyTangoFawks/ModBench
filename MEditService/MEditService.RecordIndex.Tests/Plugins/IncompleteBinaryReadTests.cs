using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class IncompleteBinaryReadTests : IDisposable
{
    private const string PluginName = "Incomplete.esp";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("incomplete-read")
        .WithPlugin(PluginName, mod =>
        {
            mod.Npcs.AddNew("TheNpc");
            mod.Weapons.AddNew("TheWeapon");
        }, origin: "IncompleteMod")
        .BuildScattered();

    public void Dispose() => _fixture.Dispose();

    private PluginAddress Plugin => _fixture.Plugins.Single().Key;

    private static readonly AdapterReadingWithoutTables NoNpcTable = new(table => table == "npc_");

    private OpenedIndex Reconciled(IPluginAdapter adapter) =>
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot, adapter);

    private static string? ReasonFor(OpenedIndex index, string plugin) =>
        index.Status.Failures.SingleOrDefault(failure => failure.Name == plugin)?.Reason;

    [Fact]
    public void ABinaryOneOfWhoseRecordTypesDoesNotReachTheIndex_FailsToRead_AndListsNoneOfItsRecords()
    {
        using var index = Reconciled(NoNpcTable);

        Assert.Contains("1 of its 2 records", ReasonFor(index, PluginName));
        Assert.Empty(index.ListedIn(Plugin));
    }

    [Fact]
    public void ABinaryThatFailedToReadWhole_FailsAgainWhenTheIndexFileIsOpenedAgain()
    {
        using (Reconciled(NoNpcTable)) { }

        using var reopened = Reconciled(NoNpcTable);

        Assert.Contains("1 of its 2 records", ReasonFor(reopened, PluginName));
    }
}
