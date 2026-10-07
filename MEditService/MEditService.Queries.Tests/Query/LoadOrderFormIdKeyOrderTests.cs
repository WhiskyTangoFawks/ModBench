using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries.Tests.Query;

public sealed class LoadOrderFormIdKeyOrderTests
{
    private static readonly PluginAddress BasePlugin = new("Base.esm", "Data");
    private static readonly PluginAddress LightPlugin = new("Light.esl", "Data");
    private static readonly PluginAddress TopPlugin = new("Top.esp", "Data");

    private static readonly FormKey ContainerKey = new(ModKey.FromFileName(BasePlugin.Name), 0x800);

    private static readonly FormKey InBase = new(ModKey.FromFileName(BasePlugin.Name), 0x900);
    private static readonly FormKey InLight = new(ModKey.FromFileName(LightPlugin.Name), 0x801);
    private static readonly FormKey InTop = new(ModKey.FromFileName(TopPlugin.Name), 0x800);
    private static readonly FormKey InUnloaded = new(ModKey.FromFileName("Unloaded.esp"), 0x700);
    private static readonly FormKey InOtherUnloaded = new(ModKey.FromFileName("Other.esp"), 0x600);

    private static readonly PluginAddress MediumPlugin = new("Medium.esm", "Data");
    private static readonly FormKey InMedium = new(ModKey.FromFileName(MediumPlugin.Name), 0x801);
    private static readonly FormKey InLightBeyondItsSpace = new(ModKey.FromFileName(LightPlugin.Name), 0x1001);
    private static readonly FormKey InMediumBeyondItsSpace = new(ModKey.FromFileName(MediumPlugin.Name), 0x10001);

    private sealed record Placed(PluginAddress Plugin, bool Light, bool Medium, ContainerEntry[] Items);

    private static CompareResult CompareOf(params Placed[] placed)
    {
        var opened = placed.ToDictionary(
            p => p.Plugin,
            p => new PluginContent(p.Light, IsMaster: p.Plugin.Name.EndsWith(".esm", StringComparison.Ordinal), IsBlueprint: false, Masters: [], RecordCount: 1, IsMedium: p.Medium));
        var rows = placed.Select((p, slot) => Row(
            new Container(ContainerKey, Fallout4Release.Fallout4) { Items = [.. p.Items] }, p.Plugin, slot));
        var plugins = placed.Select((p, slot) => new LoadOrderEntry(p.Plugin.Name, p.Plugin.Name, "Data", slot, Enabled: true, Winning: true));
        var service = QueryHost.Records(
            new FakeIndex(new FakeReads(opened, [.. rows])), FakeLoadOrder.Of(GameRelease.Fallout4, [.. plugins]));
        return service.GetCompare(ContainerKey.ToString())
            ?? throw new InvalidOperationException($"Expected {ContainerKey} to resolve to a compare result.");
    }

    private static IReadOnlyList<FieldDiff> ItemRows(ContainerEntry[] inLight, ContainerEntry[] inTop) =>
        ItemRows(new Placed(BasePlugin, false, false, []), new Placed(LightPlugin, true, false, inLight), new Placed(TopPlugin, false, false, inTop));

    private static IReadOnlyList<FieldDiff> ItemRows(params Placed[] placed) =>
        CompareOf(placed).Diffs.Single(d => d.FieldName == "Items").Children ?? [];

    private static FakeRow Row(Container record, PluginAddress plugin, int loadOrderIndex) =>
        new(RealDocuments.Of(record, plugin, loadOrderIndex, GameRelease.Fallout4));

    private static ContainerEntry Entry(FormKey item, FormKey? owner = null) => new()
    {
        Item = new ContainerItem { Item = new FormLink<IItemGetter>(item), Count = 1 },
        Data = owner is { } npc ? new ExtraData { Owner = new NpcOwner { Npc = new FormLink<INpcGetter>(npc) } } : null,
    };

    [Fact]
    public void AKeyedArraysRows_ReadInTheLoadOrderFormIdOrderOfTheirKeys_FullPluginsBeforeLightOnes()
    {
        var rows = ItemRows([], [Entry(InTop), Entry(InLight), Entry(InBase)]);

        Assert.Equal([InBase.ToString(), InTop.ToString(), InLight.ToString()], rows.Select(r => r.FieldName));
    }

    [Fact]
    public void KeysOfPluginsTheGameDoesNotLoad_ReadAfterEveryLoadedOne_InTheOrderOfTheirText()
    {
        var rows = ItemRows([], [Entry(InUnloaded), Entry(InTop), Entry(InOtherUnloaded), Entry(InBase)]);

        Assert.Equal(
            [InBase.ToString(), InTop.ToString(), InOtherUnloaded.ToString(), InUnloaded.ToString()], rows.Select(r => r.FieldName));
    }

    [Fact]
    public void EntriesAtOneKey_PairInTheLoadOrderFormIdOrderOfTheirOwners()
    {
        var ownedInBase = Entry(InBase, owner: InBase);
        var ownedInLight = Entry(InBase, owner: InLight);

        var rows = ItemRows([ownedInLight, ownedInBase], [ownedInBase]);

        var paired = rows.Single(r => r.Indexes?.ContainsKey(TopPlugin.Name) == true);
        Assert.Equal(1, paired.Indexes?[LightPlugin.Name]);
    }

    [Fact]
    public void AMediumPluginHasItsOwnSpace_BetweenTheFullPluginsAndTheLightOnes()
    {
        var rows = ItemRows(
            new Placed(BasePlugin, false, false, []), new Placed(MediumPlugin, false, true, []),
            new Placed(LightPlugin, true, false, []), new Placed(TopPlugin, false, false, [Entry(InLight), Entry(InMedium), Entry(InTop), Entry(InBase)]));

        Assert.Equal([InBase.ToString(), InTop.ToString(), InMedium.ToString(), InLight.ToString()], rows.Select(r => r.FieldName));
    }

    [Fact]
    public void AKeyBeyondItsPluginsSpace_HasNoLoadOrderFormId_AndNeverTakesAnotherRecordsPlace()
    {
        var rows = ItemRows(
            new Placed(BasePlugin, false, false, []), new Placed(MediumPlugin, false, true, []),
            new Placed(LightPlugin, true, false, []),
            new Placed(TopPlugin, false, false, [Entry(InMediumBeyondItsSpace), Entry(InLightBeyondItsSpace), Entry(InLight), Entry(InMedium)]));

        Assert.Equal(
            [InMedium.ToString(), InLight.ToString(), InLightBeyondItsSpace.ToString(), InMediumBeyondItsSpace.ToString()],
            rows.Select(r => r.FieldName));
    }

    [Fact]
    public void EachColumnsLoadIndex_CountsAmongItsOwnKind_AFullOneInHex_AMediumOneAfterFD_ALightOneAfterFE()
    {
        var compare = CompareOf(
            new Placed(BasePlugin, false, false, []), new Placed(MediumPlugin, false, true, []),
            new Placed(LightPlugin, true, false, []), new Placed(TopPlugin, false, false, []));

        Assert.Equal(["00", "FD 00", "FE 000", "01"], compare.Overrides.Select(o => o.LoadIndex));
    }
}
