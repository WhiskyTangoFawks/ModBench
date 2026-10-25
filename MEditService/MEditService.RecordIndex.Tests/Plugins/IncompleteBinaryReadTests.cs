using MEditService.Codec.Schema;
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

    private static readonly AdapterReadingWithoutTables EveryRecordTable = new(table => table != PluginHeader.RecordType);

    private OpenedIndex Reconciled(IPluginAdapter adapter) =>
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot, adapter);

    private static string? ReasonFor(OpenedIndex index, string plugin) =>
        index.Status.Failures.SingleOrDefault(failure => failure.Name == plugin)?.Reason;

    [Fact]
    public void ABinaryNoneOfWhoseRecordsReachTheIndex_FailsToRead_AndNamesHowManyItHolds()
    {
        using var index = Reconciled(EveryRecordTable);

        Assert.Contains("0 of its 2 records", ReasonFor(index, PluginName));
    }

    [Fact]
    public void ABinaryOneOfWhoseRecordTypesDoesNotReachTheIndex_FailsToRead_AndListsNoneOfItsRecords()
    {
        using var index = Reconciled(new AdapterReadingWithoutTables(table => table == "npc_"));

        Assert.Contains("1 of its 2 records", ReasonFor(index, PluginName));
        Assert.Empty(index.ListedIn(Plugin));
    }

    [Fact]
    public void ABinaryThatFailedToReadWhole_FailsAgainWhenTheIndexFileIsOpenedAgain()
    {
        using (Reconciled(EveryRecordTable)) { }

        using var reopened = Reconciled(EveryRecordTable);

        Assert.Contains("0 of its 2 records", ReasonFor(reopened, PluginName));
    }
}
