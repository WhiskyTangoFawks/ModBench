using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class PluginTreeFilesMadeTests
{
    private const string PluginName = "Made.esp";
    private const string CoinFormKey = "000801:Made.esp";
    private static readonly ModKey MadeKey = ModKey.FromFileName(PluginName);
    private static readonly RecordTypes Types = RecordTypes.For(GameRelease.Fallout4);

    private static IReadOnlyList<TreeFile> HeaderOf(IModGetter mod) =>
    [
        new TreeFile(DocumentFileNames.Root, HeaderDocument.Write(mod)),
        SpriggitMeta.Of(GameCodecs.For(GameRelease.Fallout4), mod.ModKey, GameRelease.Fallout4),
    ];

    private static PluginTreeFiles Made(IReadOnlyList<MadeRecord> records) =>
        PluginTreeFiles.Made(PluginName, HeaderOf(new Fallout4Mod(MadeKey, Fallout4Release.Fallout4)), records, GameRelease.Fallout4).Value();

    private static PluginTreeFiles CoinTree() =>
        Made([new MadeRecord(new RecordIdentity(CoinFormKey, "glob", "Coin"), "{\n  \"FormKey\": \"000801:Made.esp\",\n  \"EditorID\": \"Coin\",\n  \"Weight\": 2\n}")]);

    private static RecordIdentity IdentityOf(IMajorRecordGetter record) => new(record.FormKey.ToString(), Types.RecordTypeOf(record), record.EditorID);

    private static MadeRecord OwnFieldsOf(IMajorRecordGetter record, DocumentContainment? container = null, string? worldspace = null) =>
        new(
            IdentityOf(record),
            ContainerDocumentEdits.WithoutChildren(RecordTextCodec.SerializeToText(record, GameRelease.Fallout4), GameRelease.Fallout4, Types.RecordTypeOf(record)),
            container, worldspace);

    private static DocumentContainment In(IMajorRecordGetter container, string slot) =>
        new(container.FormKey.ToString(), Types.RecordTypeOf(container), slot);

    private static async Task<IReadOnlyList<TreeFile>> DoorTreeOf(Fallout4Mod mod)
    {
        using var folder = new ScratchDirectory("medit-made-door-");
        await Fallout4WholeMod.Serialize(mod, folder);
        return
        [
            .. Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
                .Select(file => new TreeFile(Path.GetRelativePath(folder, file), File.ReadAllBytes(file))),
            SpriggitMeta.Of(GameCodecs.For(GameRelease.Fallout4), mod.ModKey, GameRelease.Fallout4),
        ];
    }

    private static void AddInteriorCellInItsFormIdsBlock(Fallout4Mod mod, Cell cell)
    {
        var subBlock = new CellSubBlock { BlockNumber = (int)(cell.FormKey.ID / 10 % 10), GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = (int)(cell.FormKey.ID % 10), GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    [Fact]
    public async Task RecordsGivenWithTheirContainers_LandWhereTheWholeModDoorWritesTheModHoldingThem()
    {
        var mod = new Fallout4Mod(MadeKey, Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("MadeNpc");
        var world = mod.Worldspaces.AddNew("MadeWorld");
        var exterior = new Cell(mod) { EditorID = "MadeExterior", Grid = new CellGrid { Point = new P2Int(9, -1) } };
        var exteriorRef = new PlacedObject(mod) { EditorID = "MadeExteriorRef" };
        exterior.Temporary.Add(exteriorRef);
        var subBlock = new WorldspaceSubBlock { BlockNumberX = 1, BlockNumberY = -1 };
        subBlock.Items.Add(exterior);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = -1 };
        block.Items.Add(subBlock);
        world.SubCells.Add(block);
        var topCell = new Cell(mod) { EditorID = "MadeTopCell" };
        var persistentRef = new PlacedObject(mod) { EditorID = "MadePersistentRef" };
        topCell.Persistent.Add(persistentRef);
        world.TopCell = topCell;
        var interior = new Cell(mod) { EditorID = "MadeInterior", Flags = Cell.Flag.IsInteriorCell };
        var interiorRef = new PlacedObject(mod) { EditorID = "MadeInteriorRef" };
        interior.Persistent.Add(interiorRef);
        AddInteriorCellInItsFormIdsBlock(mod, interior);
        var quest = mod.Quests.AddNew("MadeQuest");
        var topic = new DialogTopic(mod) { EditorID = "MadeTopic" };
        var response = new DialogResponses(mod);
        topic.Responses.Add(response);
        quest.DialogTopics.Add(topic);

        var made = PluginTreeFiles.Made(
            PluginName, HeaderOf(mod),
            [
                OwnFieldsOf(npc),
                OwnFieldsOf(interiorRef, In(interior, nameof(Cell.Persistent))),
                OwnFieldsOf(interior),
                OwnFieldsOf(exteriorRef, In(exterior, nameof(Cell.Temporary))),
                OwnFieldsOf(exterior, worldspace: world.FormKey.ToString()),
                OwnFieldsOf(persistentRef, In(topCell, nameof(Cell.Persistent))),
                OwnFieldsOf(topCell, In(world, PlacedCell.WorldspacePersistentCellMember)),
                OwnFieldsOf(world),
                OwnFieldsOf(response, In(topic, nameof(DialogTopic.Responses))),
                OwnFieldsOf(topic, In(quest, nameof(Quest.DialogTopics))),
                OwnFieldsOf(quest),
            ],
            GameRelease.Fallout4).Value();

        var comparison = made.Compare(await DoorTreeOf(mod)).Value();
        Assert.Empty((string[])[.. comparison.Divergences.Select(divergence => divergence.ToString()), .. comparison.Misplaced.Select(file => file.ToString())]);
    }

    [Fact]
    public void AChildNoReaderTakes_IsUnreadable()
    {
        var mod = new Fallout4Mod(MadeKey, Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "MadeInterior", Flags = Cell.Flag.IsInteriorCell };
        var placed = new PlacedObject(mod);
        var unread = new MadeRecord(IdentityOf(placed), "[]", In(cell, nameof(Cell.Persistent)));

        var made = PluginTreeFiles.Made(PluginName, HeaderOf(mod), [OwnFieldsOf(cell), unread], GameRelease.Fallout4);

        Assert.IsType<SourceFailure.Unreadable>(made.Stopped());
    }

    [Fact]
    public void TwoCellsInAWorldspacesOneSlot_IsTheSlotHeld()
    {
        var mod = new Fallout4Mod(MadeKey, Fallout4Release.Fallout4);
        var world = mod.Worldspaces.AddNew("MadeWorld");
        var slot = In(world, PlacedCell.WorldspacePersistentCellMember);

        var made = PluginTreeFiles.Made(
            PluginName, HeaderOf(mod), [OwnFieldsOf(world), OwnFieldsOf(new Cell(mod), slot), OwnFieldsOf(new Cell(mod), slot)], GameRelease.Fallout4);

        Assert.IsType<SourceFailure.SlotHeld>(made.Stopped());
    }

    [Fact]
    public void ARefusedDocument_IsNamedByTheRecordItHolds()
    {
        var tree = CoinTree();

        var refused = Assert.Single(tree.RefusedFiles().Value());

        Assert.Equal(CoinFormKey, tree.Named(refused.Path));
    }

    [Fact]
    public void ADiagnosisOfARead_NamesTheRecordEachFileItCarriesHolds()
    {
        var coinPath = Path.Combine("Globals", "Coin - 000801_Made.esp.json");
        var read = new PluginDiagnosis(coinPath, PluginDiagnosis.UnknownClass, null, $"Could not read {coinPath}.");

        var named = CoinTree().Named(read).Value();

        Assert.Equal((CoinFormKey, $"Could not read {CoinFormKey}."), (named.Anchor, named.Message));
    }

    [Fact]
    public void ADiagnosisOfARead_NamesAFileTheTreeDoesNotHold_ByItsPathInTheTree()
    {
        var other = Path.Combine("Globals", "Other.json");
        var read = new PluginDiagnosis(other, PluginDiagnosis.UnknownClass, null, $"Could not read {other}.");

        var named = CoinTree().Named(read).Value();

        Assert.Equal((other, $"Could not read {other}."), (named.Anchor, named.Message));
    }

    [Fact]
    public void ARecord_IsInNoFile_AndIsNamedByItself()
    {
        var coin = new RecordIdentity(CoinFormKey, "glob", "Coin");
        var tree = CoinTree();

        Assert.Equal(((string?)null, CoinFormKey), (tree.FileOf(coin).Value(), tree.Named(coin).Value()));
    }
}
