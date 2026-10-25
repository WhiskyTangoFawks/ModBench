using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class DuplicateFormKeyTests : IDisposable
{
    private const string PluginName = "Duplicate.esp";
    private const string HeldTwice = "000800:Duplicate.esp";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("duplicate-formkey")
        .WithPlugin(PluginName, mod =>
        {
            var npc = mod.Npcs.AddNew("TheNpc");
            mod.Weapons.Add(new Weapon(npc.FormKey, Fallout4Release.Fallout4) { EditorID = "TheWeapon" });
            mod.Armors.AddNew("TheArmor");
        }, origin: "DuplicateMod", writeParams: new BinaryWriteParameters { FormIDUniqueness = FormIDUniquenessOption.NoCheck })
        .BuildScattered();

    public void Dispose() => _fixture.Dispose();

    private PluginAddress Plugin => _fixture.Plugins.Single().Key;

    private const string Diagnosis = $"duplicate FormKey {HeldTwice}, in its Non-Player Character and Weapon groups";

    [Fact]
    public void ABinaryHoldingOneFormKeyInTwoGroups_FailsToRead_DiagnosingTheFormKeyAndBothGroups()
    {
        using var index = Indexes.Reconciled(_fixture);

        var failure = Assert.Single(index.Status.Failures, failure => failure.Name == PluginName);
        Assert.Equal(Diagnosis, failure.Diagnosis);
        Assert.Contains(Diagnosis, failure.Reason);
        Assert.Empty(index.ListedIn(Plugin));
    }

    [Fact]
    public void ABinaryAlsoShortOfRecords_IsDiagnosedWithTheDuplicate()
    {
        using var index = Indexes.Reconciled(_fixture, adapter: new AdapterReadingWithoutTables(table => table == "armo"));

        Assert.Equal(Diagnosis, Assert.Single(index.Status.Failures, failure => failure.Name == PluginName).Diagnosis);
    }

    [Fact]
    public void ARefusedReRead_KeepsTheLastGoodRows()
    {
        using var lastGood = new PluginFixtureBuilder("duplicate-reread")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("LastGoodNpc"), origin: "DuplicateMod")
            .BuildScattered();
        using var index = Indexes.Reconciled(lastGood);

        File.Copy(_fixture.Plugins.Single().Path, lastGood.Plugins.Single().Path, overwrite: true);
        index.NextSnapshotUntil(() => index.Status.Failures.Any(failure => failure.Name == PluginName), "the re-read's failure");

        Assert.Equal(["LastGoodNpc"], index.ListedIn(lastGood.Plugins.Single().Key).Select(row => row.EditorId));
    }

    [Fact]
    public void ABinaryMutagenCannotRead_FailsToRead_WithNoDiagnosis()
    {
        File.WriteAllText(_fixture.Plugins.Single().Path, "not a plugin");

        using var index = Indexes.Reconciled(_fixture);

        Assert.Null(Assert.Single(index.Status.Failures, failure => failure.Name == PluginName).Diagnosis);
    }
}
