using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class RecordListOrderTests
{
    private static readonly PluginAddress Patch = new("Patch.esp", "PatchMod");

    private static List<string?> ActivatorsOfPatch(ScatteredFixtureData fixture)
    {
        using var index = Indexes.Reconciled(fixture);
        return [.. index.Queries.GetRecords(["acti"], Patch, search: null, limit: 10, offset: 0).Value().Items.Select(r => r.EditorId)];
    }

    [Fact]
    public void AGroupsRecords_ListALightMastersRecordsAfterAFullMastersLoadedAfterIt()
    {
        using var fixture = new PluginFixtureBuilder("record-list-light-order")
            .WithPlugin("Light.esl", mod => mod.Activators.AddNew("ALightLever"), origin: "LightMod")
            .WithPlugin("Full.esm", mod => mod.Activators.AddNew("ZFullLever"), origin: "FullMod")
            .WithPlugin("Patch.esp", (mod, masters) =>
            {
                mod.Activators.GetOrAddAsOverride(masters[0].Activators.Single());
                mod.Activators.GetOrAddAsOverride(masters[1].Activators.Single());
            }, origin: Patch.Origin)
            .BuildScattered();

        Assert.Equal(["ZFullLever", "ALightLever"], ActivatorsOfPatch(fixture));
    }

    [Theory]
    [InlineData("FullTwin", "LightTwin", new[] { "ZTwinLever", "ALateLever" })]
    [InlineData("LightTwin", "FullTwin", new[] { "ALateLever", "ZTwinLever" })]
    public void AFilenamesFormIds_SortAsThePluginTheGameLoadsUnderIt_NotAnOverriddenCopy(
        string winnerOrigin, string loserOrigin, string[] expected)
    {
        static Action<Fallout4Mod> Twin(string origin) => mod =>
        {
            mod.IsSmallMaster = origin == "LightTwin";
            mod.Activators.AddNew("ZTwinLever");
        };
        using var fixture = new PluginFixtureBuilder("record-list-twin-order")
            .WithPlugin("Twin.esp", Twin(loserOrigin), origin: loserOrigin)
            .WithPlugin("Twin.esp", Twin(winnerOrigin), origin: winnerOrigin)
            .WithPlugin("Late.esm", mod => mod.Activators.AddNew("ALateLever"), origin: "LateMod")
            .WithPlugin("Patch.esp", (mod, masters) =>
            {
                mod.Activators.GetOrAddAsOverride(masters[1].Activators.Single());
                mod.Activators.GetOrAddAsOverride(masters[2].Activators.Single());
            }, origin: Patch.Origin)
            .BuildScattered();

        Assert.Equal(expected, ActivatorsOfPatch(fixture));
    }
}
