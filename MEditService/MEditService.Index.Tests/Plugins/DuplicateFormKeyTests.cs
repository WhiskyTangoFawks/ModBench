using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.Index.Tests.Plugins;

public sealed class DuplicateFormKeyTests : IDisposable
{
    private const string PluginName = "Duplicate.esp";
    private const string HeldTwice = "000800:Duplicate.esp";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("duplicate-formkey")
        .WithPlugin(PluginName, mod =>
        {
            var npc = mod.Npcs.AddNew("TheNpc");
            mod.Weapons.Add(new Weapon(npc.FormKey, Fallout4Release.Fallout4) { EditorID = "TheWeapon" });
        }, origin: "DuplicateMod", writeParams: new BinaryWriteParameters { FormIDUniqueness = FormIDUniquenessOption.NoCheck })
        .BuildScattered();

    public void Dispose() => _fixture.Dispose();

    private PluginAddress Plugin => _fixture.Plugins.Single().KeyOf();

    [Fact]
    public void ABinaryHoldingOneFormKeyInTwoGroups_FailsToRead_DiagnosingTheFormKeyAndBothGroups()
    {
        using var index = Indexes.Reconciled(_fixture);

        var failure = Assert.Single(index.Status.Failures, failure => failure.Name == PluginName);
        var diagnosis = $"duplicate FormKey {HeldTwice}, in its Non-Player Character and Weapon groups";
        Assert.Equal(diagnosis, failure.Diagnosis);
        Assert.Contains(diagnosis, failure.Reason);
        Assert.Empty(index.ListedIn(Plugin));
    }

    [Fact]
    public void ABinaryMutagenCannotRead_FailsToRead_WithNoDiagnosis()
    {
        File.WriteAllText(_fixture.Plugins.Single().Path, "not a plugin");

        using var index = Indexes.Reconciled(_fixture);

        Assert.Null(Assert.Single(index.Status.Failures, failure => failure.Name == PluginName).Diagnosis);
    }
}
