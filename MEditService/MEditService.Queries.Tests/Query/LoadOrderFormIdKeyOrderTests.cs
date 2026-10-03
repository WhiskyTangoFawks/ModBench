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

    private static IReadOnlyList<FieldDiff> ItemRows(ContainerEntry[] inLight, ContainerEntry[] inTop)
    {
        var opened = new Dictionary<PluginAddress, PluginContent>
        {
            [BasePlugin] = new(IsLight: false, IsMaster: true, IsBlueprint: false, Masters: [], RecordCount: 1),
            [LightPlugin] = new(IsLight: true, IsMaster: true, IsBlueprint: false, Masters: [BasePlugin.Name], RecordCount: 1),
            [TopPlugin] = new(IsLight: false, IsMaster: false, IsBlueprint: false, Masters: [BasePlugin.Name, LightPlugin.Name], RecordCount: 1),
        };
        var rows = new[]
        {
            Row(new Container(ContainerKey, Fallout4Release.Fallout4), BasePlugin, 0, isWinner: false),
            Row(new Container(ContainerKey, Fallout4Release.Fallout4) { Items = [.. inLight] }, LightPlugin, 1, isWinner: false),
            Row(new Container(ContainerKey, Fallout4Release.Fallout4) { Items = [.. inTop] }, TopPlugin, 2, isWinner: true),
        };
        var plugins = new[]
        {
            new LoadOrderEntry(BasePlugin.Name, BasePlugin.Name, "Data", 0, Enabled: true, Winning: true),
            new LoadOrderEntry(LightPlugin.Name, LightPlugin.Name, "Data", 1, Enabled: true, Winning: true),
            new LoadOrderEntry(TopPlugin.Name, TopPlugin.Name, "Data", 2, Enabled: true, Winning: true),
        };
        var service = new RecordQueryService(
            new FakeIndex(new FakeReads(opened, rows)), FakeLoadOrder.Of(GameRelease.Fallout4, plugins),
            SharedSchemaReflector.Instance, new ConflictClassifier());
        var compare = service.GetCompare(ContainerKey.ToString())
            ?? throw new InvalidOperationException($"Expected {ContainerKey} to resolve to a compare result.");
        return compare.Diffs.Single(d => d.FieldName == "Items").Children ?? [];
    }

    private static FakeRow Row(Container record, PluginAddress plugin, int loadOrderIndex, bool isWinner) =>
        new(plugin, loadOrderIndex, isWinner, RealDocuments.Of(record, plugin, loadOrderIndex, isWinner, GameRelease.Fallout4, "cont", ["Items"]));

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
}
