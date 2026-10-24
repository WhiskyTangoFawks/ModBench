using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class ModelIdentityTests
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    [Fact]
    public async Task DivergenceFrom_OfAPluginWhoseRecordsAreRedeflatedAndHoldANegativeZero_ReturnsNull()
    {
        var (divergence, originalBytes, rewrittenBytes) = await ParseRewriteAndCompare(NegativeZeroPlugin.Plugin);

        Assert.False(RawPlugin.FirstMiscZlibHeader(originalBytes).SequenceEqual(RawPlugin.FirstMiscZlibHeader(rewrittenBytes)),
            "The rewrite does not re-deflate the generated plugin's records — this test does not exercise the re-deflate it depends on.");
        Assert.Null(divergence);
    }

    [Theory]
    [InlineData(1.5f, 2.5f)]
    [InlineData(0f, 5e-10f)]
    public async Task DivergenceFrom_WhenAFloatGenuinelyDiffers_NamesTheRecordAndTheField_EvenWithinTheEpsilonOfMutagensEqualsMask(
        float original, float recompiledValue)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("OriginalNpc");
        npc.HeightMin = original;

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        recompiled.Npcs.Add(new Npc(npc.FormKey, Fallout4Release.Fallout4) { EditorID = "OriginalNpc", HeightMin = recompiledValue });

        var divergence = await DivergenceAsync(mod, recompiled);

        Assert.NotNull(divergence);
        Assert.StartsWith($"Npc {npc.FormKey} ", divergence, StringComparison.Ordinal);
        Assert.Contains("HeightMin", divergence);
    }

    [Fact]
    public async Task DivergenceFrom_WhenAWorldspacesBlockLevelsAreInAnotherOrder_ReturnsNull_BecauseBlockSubBlockAndCellOrderIsEncodingTheTreeCarriesNoneSoTheReadersDirectoryEnumerationDecidesIt()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var ws = mod.Worldspaces.AddNew("TestWs");
        var cellA = new Cell(mod) { EditorID = "CellA", Grid = new CellGrid { Point = new Noggog.P2Int(0, 0) } };
        var cellB = new Cell(mod) { EditorID = "CellB", Grid = new CellGrid { Point = new Noggog.P2Int(1, 0) } };
        var cellC = new Cell(mod) { EditorID = "CellC", Grid = new CellGrid { Point = new Noggog.P2Int(8, 8) } };
        ws.SubCells.Add(Block(0, 0, SubBlock(0, 0, cellA, cellB)));
        ws.SubCells.Add(Block(1, 1, SubBlock(2, 2, cellC)));

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledWs = new Worldspace(ws.FormKey, Fallout4Release.Fallout4) { EditorID = "TestWs" };
        recompiledWs.SubCells.Add(Block(1, 1, SubBlock(2, 2, cellC.DeepCopy())));
        recompiledWs.SubCells.Add(Block(0, 0, SubBlock(0, 0, cellB.DeepCopy(), cellA.DeepCopy())));
        recompiled.Worldspaces.Add(recompiledWs);

        Assert.Null(await DivergenceAsync(mod, recompiled));
    }

    [Fact]
    public async Task DivergenceFrom_WhenACellUnderAWorldspaceBlockGenuinelyDiffers_NamesIt()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var ws = mod.Worldspaces.AddNew("TestWs");
        var cell = new Cell(mod) { EditorID = "CellA", Grid = new CellGrid { Point = new Noggog.P2Int(0, 0) } };
        ws.SubCells.Add(Block(0, 0, SubBlock(0, 0, cell)));

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledWs = new Worldspace(ws.FormKey, Fallout4Release.Fallout4) { EditorID = "TestWs" };
        var changed = cell.DeepCopy();
        var grid = changed.Grid ?? throw new InvalidOperationException("Expected the deep-copied cell to keep its grid.");
        grid.Point = new Noggog.P2Int(0, 1);
        recompiledWs.SubCells.Add(Block(0, 0, SubBlock(0, 0, changed)));
        recompiled.Worldspaces.Add(recompiledWs);

        var divergence = await DivergenceAsync(mod, recompiled);

        Assert.NotNull(divergence);
        Assert.Contains("Point", divergence);
    }

    [Fact]
    public async Task DivergenceFrom_WhenACellSitsUnderAnotherBlockCoordinate_NamesIt_TheOneThingTheWorldspacesOwnComparisonGuardsThatThePerRecordWalkDoesNot()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var ws = mod.Worldspaces.AddNew("TestWs");
        var cell = new Cell(mod) { EditorID = "CellA", Grid = new CellGrid { Point = new Noggog.P2Int(0, 0) } };
        ws.SubCells.Add(Block(0, 0, SubBlock(0, 0, cell)));

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledWs = new Worldspace(ws.FormKey, Fallout4Release.Fallout4) { EditorID = "TestWs" };
        recompiledWs.SubCells.Add(Block(5, 0, SubBlock(0, 0, cell.DeepCopy())));
        recompiled.Worldspaces.Add(recompiledWs);

        var divergence = await DivergenceAsync(mod, recompiled);

        Assert.NotNull(divergence);
        Assert.StartsWith("Worldspace ", divergence, StringComparison.Ordinal);
        Assert.Contains("BlockNumberX", divergence);
    }

    private static WorldspaceBlock Block(short x, short y, params WorldspaceSubBlock[] subBlocks)
    {
        var block = new WorldspaceBlock { BlockNumberX = x, BlockNumberY = y };
        block.Items.AddRange(subBlocks);
        return block;
    }

    private static WorldspaceSubBlock SubBlock(short x, short y, params Cell[] cells)
    {
        var subBlock = new WorldspaceSubBlock { BlockNumberX = x, BlockNumberY = y };
        subBlock.Items.AddRange(cells);
        return subBlock;
    }

    private static (Fallout4Mod Original, Fallout4Mod Recompiled) AnInteriorCellsStamps()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "TestCell", Timestamp = 1, UnknownGroupData = 2 };
        var placed = new PlacedObject(mod);
        cell.Temporary.Add(placed);
        mod.AddInteriorCells(cell);

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledCell = new Cell(cell.FormKey, Fallout4Release.Fallout4) { EditorID = "TestCell", Timestamp = 99, UnknownGroupData = 100 };
        recompiledCell.Temporary.Add(new PlacedObject(placed.FormKey, Fallout4Release.Fallout4));
        recompiled.AddInteriorCells(recompiledCell);
        return (mod, recompiled);
    }

    private static (Fallout4Mod Original, Fallout4Mod Recompiled) AWorldspacesTopCellsStamps()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var ws = mod.Worldspaces.AddNew("TestWs");
        var topCell = new Cell(mod) { Timestamp = 1, UnknownGroupData = 2 };
        var placed = new PlacedObject(mod);
        topCell.Temporary.Add(placed);
        ws.TopCell = topCell;

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledWs = new Worldspace(ws.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "TestWs",
            TopCell = new Cell(topCell.FormKey, Fallout4Release.Fallout4) { Timestamp = 99, UnknownGroupData = 100 },
        };
        recompiledWs.TopCell.Temporary.Add(new PlacedObject(placed.FormKey, Fallout4Release.Fallout4));
        recompiled.Worldspaces.Add(recompiledWs);
        return (mod, recompiled);
    }

    private static (Fallout4Mod Original, Fallout4Mod Recompiled) AWorldspaceBlocksStamps()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var ws = mod.Worldspaces.AddNew("TestWs");
        ws.SubCells.Add(new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0, LastModified = 1, Unknown = 2 });

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledWs = new Worldspace(ws.FormKey, Fallout4Release.Fallout4) { EditorID = "TestWs" };
        recompiledWs.SubCells.Add(new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0, LastModified = 99, Unknown = 100 });
        recompiled.Worldspaces.Add(recompiledWs);
        return (mod, recompiled);
    }

    private static (Fallout4Mod Original, Fallout4Mod Recompiled) AQuestsNestedTopicsStamps()
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var quest = original.Quests.AddNew("TestQuest");
        var topic = new DialogTopic(original) { Quest = quest.ToLink(), Timestamp = 140636, Unknown = 467 };
        var response = new DialogResponses(original);
        topic.Responses.Add(response);
        quest.DialogTopics.Add(topic);

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledQuest = new Quest(quest.FormKey, Fallout4Release.Fallout4) { EditorID = "TestQuest" };
        var recompiledTopic = new DialogTopic(topic.FormKey, Fallout4Release.Fallout4) { Quest = quest.ToLink() };
        recompiledTopic.Responses.Add(new DialogResponses(response.FormKey, Fallout4Release.Fallout4));
        recompiledQuest.DialogTopics.Add(recompiledTopic);
        recompiled.Quests.Add(recompiledQuest);
        return (original, recompiled);
    }

    public static TheoryData<string, Func<(Fallout4Mod Original, Fallout4Mod Recompiled)>> DifferingOnlyInGroupHeaderDerivedFields => new()
    {
        { "an interior cell's", AnInteriorCellsStamps },
        { "a worldspace's top cell's", AWorldspacesTopCellsStamps },
        { "a worldspace block's", AWorldspaceBlocksStamps },
        { "a quest's nested topic's", AQuestsNestedTopicsStamps },
    };

    [Theory]
    [MemberData(nameof(DifferingOnlyInGroupHeaderDerivedFields))]
    public async Task DivergenceFrom_WhenOnlyGroupHeaderDerivedFieldsDiffer_ReturnsNull(string _, Func<(Fallout4Mod Original, Fallout4Mod Recompiled)> mods)
    {
        var (original, recompiled) = mods();

        Assert.Null(await DivergenceAsync(original, recompiled));
    }

    [Fact]
    public async Task DivergenceFrom_WithMatchingOpaqueFields_ReturnsNull()
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        SetOpaqueHeaderFields(original);

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        SetOpaqueHeaderFields(recompiled);

        var divergence = await DivergenceAsync(original, recompiled);

        Assert.Null(divergence);
    }

    public static IEnumerable<object[]> AllowListedHeaderFieldCorruptions()
    {
        yield return new object[] { "TypeOffsets", "TypeOffsets", Setter(h => h.TypeOffsets = new byte[] { 1, 2, 3 }), Setter(h => h.TypeOffsets = new byte[] { 9, 9, 9 }) };
        yield return new object[] { "Deleted", "Deleted", Setter(h => h.Deleted = new byte[] { 1, 2, 3 }), Setter(h => h.Deleted = new byte[] { 9, 9, 9 }) };
        yield return new object[] { "Screenshot", "Screenshot", Setter(h => h.Screenshot = new byte[] { 1, 2, 3 }), Setter(h => h.Screenshot = new byte[] { 9, 9, 9 }) };
        yield return new object[] { "INTV", "INTV", Setter(h => h.INTV = new byte[] { 1, 0, 0, 0 }), Setter(h => h.INTV = new byte[] { 99, 0, 0, 0 }) };
        yield return new object[] { "INCC", "INCC", Setter(h => h.INCC = 1), Setter(h => h.INCC = 2) };
        yield return new object[] { "Author", "Author", Setter(h => h.Author = "Original"), Setter(h => h.Author = "Corrupted") };
        yield return new object[] { "Description", "Description", Setter(h => h.Description = "Original"), Setter(h => h.Description = "Corrupted") };
        yield return new object[] { "TransientTypes, an item", "TransientTypes", Setter(h => h.TransientTypes.Add(new TransientType { FormType = 7 })), Setter(h => h.TransientTypes.Add(new TransientType { FormType = 99 })) };
        yield return new object[] { "TransientTypes, the count", "TransientTypes", Setter(h => h.TransientTypes.Add(new TransientType { FormType = 7 })), Setter(_ => { }) };

        static Action<Fallout4ModHeader> Setter(Action<Fallout4ModHeader> action) => action;
    }

    [Theory]
    [MemberData(nameof(AllowListedHeaderFieldCorruptions))]
    public async Task DivergenceFrom_ForEveryAllowListedField_NamesItWhenItAloneDiverges(
        string _, string fieldName, Action<Fallout4ModHeader> setOriginal, Action<Fallout4ModHeader> setCorrupted)
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        setOriginal(original.ModHeader);

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        setCorrupted(recompiled.ModHeader);

        var divergence = await DivergenceAsync(original, recompiled);

        Assert.NotNull(divergence);
        Assert.Contains($"'{fieldName}'", divergence, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DivergenceFrom_WhenOnlyAnExcludedFieldDiffers_ReturnsNull()
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        original.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Localized;

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);

        var divergence = await DivergenceAsync(original, recompiled);

        Assert.Null(divergence);
    }

    [Fact]
    public async Task DivergenceFrom_WhenOnlyAGenderedItemSubFieldDiffers_ReportsTheDivergence()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var armor = mod.Armors.AddNew("GenderedArmor");
        armor.WorldModel = new GenderedItem<ArmorModel?>(
            new ArmorModel { Model = new Model { File = "male.nif" } }, null);

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledArmor = new Armor(armor.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "GenderedArmor",
            WorldModel = new GenderedItem<ArmorModel?>(
                new ArmorModel { Model = new Model { File = "DIFFERENT.nif" } }, null),
        };
        recompiled.Armors.Add(recompiledArmor);

        var divergence = await DivergenceAsync(mod, recompiled);

        Assert.NotNull(divergence);
        Assert.Contains(armor.FormKey.ToString(), divergence, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DivergenceFrom_WhenOnlyAPackageDataIntValueDiffers_ReportsTheDivergence()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var package = mod.Packages.AddNew("IntPackage");
        package.Data.Add(0, new PackageDataInt { Name = "Count", Data = 1 });

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledPackage = new Package(package.FormKey, Fallout4Release.Fallout4) { EditorID = "IntPackage" };
        recompiledPackage.Data.Add(0, new PackageDataInt { Name = "Count", Data = 99 });
        recompiled.Packages.Add(recompiledPackage);

        var divergence = await DivergenceAsync(mod, recompiled);

        Assert.NotNull(divergence);
        Assert.Contains(package.FormKey.ToString(), divergence, StringComparison.Ordinal);
        Assert.Contains("field 'Data[0].Data' changed", divergence, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DivergenceFrom_WhenAnOrderedKeyValueShapedListIsReordered_ReportsTheDivergence_BecauseNpcMorphsIsAnOrderedListSoAReorderIsARealContentChangeNotDictionaryEnumerationOrderEvenThoughNpcMorphIsExactlyKeyAndValue()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("MorphNpc");
        npc.Morphs.Add(new NpcMorph { Key = 1, Value = 0.25f });
        npc.Morphs.Add(new NpcMorph { Key = 2, Value = 0.75f });

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledNpc = new Npc(npc.FormKey, Fallout4Release.Fallout4) { EditorID = "MorphNpc" };
        recompiledNpc.Morphs.Add(new NpcMorph { Key = 2, Value = 0.75f });
        recompiledNpc.Morphs.Add(new NpcMorph { Key = 1, Value = 0.25f });
        recompiled.Npcs.Add(recompiledNpc);

        Assert.NotNull(await DivergenceAsync(mod, recompiled));
    }

    public static TheoryData<string, Condition.Function, int, FormKey> ParametersAPrunedMasterRenumbers => new()
    {
        { "a perk the function reads", Condition.Function.HasPerk, 0, PerkInLastMaster },
        { "a record an unused parameter would name", Condition.Function.IsAttacking, 0x0100_0800, FormKey.Null },
    };

    [Theory]
    [MemberData(nameof(ParametersAPrunedMasterRenumbers))]
    public async Task DivergenceFrom_WhenAPrunedMasterRenumbersAConditionParameter_ReturnsNull(
        string _, Condition.Function function, int parameterOne, FormKey parameterOneRecord)
    {
        var original = PluginWithARecipeCondition(ConditionData(function, parameterOne, parameterOneRecord), UnreferencedMaster, PerkInLastMaster.ModKey);
        var recompiled = PluginWithARecipeCondition(ConditionData(function, parameterOne, parameterOneRecord));

        Assert.Null(await DivergenceWithOriginalMastersKeptAsync(original, recompiled));
    }

    [Fact]
    public async Task DivergenceFrom_WhenAPrunedMasterRenumbersAConditionInADialogTopicsResponse_ReturnsNull()
    {
        var original = PluginWithATopicCondition(UnreferencedMaster, PerkInLastMaster.ModKey);
        var recompiled = PluginWithATopicCondition();

        Assert.Null(await DivergenceWithOriginalMastersKeptAsync(original, recompiled));
    }

    [Fact]
    public async Task DivergenceFrom_WhenAConditionsFormParameterNamesAnotherRecord_NamesIt()
    {
        var original = PluginWithARecipeCondition(HasPerk(PerkInLastMaster), UnreferencedMaster, PerkInLastMaster.ModKey);
        var recompiled = PluginWithARecipeCondition(HasPerk(new FormKey(PerkInLastMaster.ModKey, 0x801)));

        Assert.Contains("ParameterOneRecord", await DivergenceWithOriginalMastersKeptAsync(original, recompiled), StringComparison.Ordinal);
    }

    private static readonly ModKey UnreferencedMaster = ModKey.FromFileName("Unreferenced.esm");
    private static readonly FormKey PerkInLastMaster = new(ModKey.FromFileName("Perks.esm"), 0x800);

    private static FunctionConditionData ConditionData(Condition.Function function, int parameterOne, FormKey parameterOneRecord)
    {
        var data = new FunctionConditionData { Function = function, ParameterOneNumber = parameterOne };
        data.ParameterOneRecord.SetTo(parameterOneRecord);
        return data;
    }

    private static FunctionConditionData HasPerk(FormKey perk) => ConditionData(Condition.Function.HasPerk, 0, perk);

    private static Fallout4Mod PluginWithARecipeCondition(FunctionConditionData data, params ModKey[] masters)
    {
        var mod = PluginDeclaring(masters);
        mod.ConstructibleObjects.AddNew("Recipe").Conditions.Add(new ConditionFloat { Data = data });
        return mod;
    }

    private static Fallout4Mod PluginWithATopicCondition(params ModKey[] masters)
    {
        var mod = PluginDeclaring(masters);
        var quest = mod.Quests.AddNew("Quest");
        var topic = new DialogTopic(mod) { Quest = quest.ToLink() };
        topic.Responses.Add(new DialogResponses(mod)
        {
            Conditions = { new ConditionFloat { Data = HasPerk(PerkInLastMaster) } },
        });
        quest.DialogTopics.Add(topic);
        return mod;
    }

    private static Fallout4Mod PluginDeclaring(ModKey[] masters)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        mod.ModHeader.MasterReferences.AddRange(masters.Select(master => new MasterReference { Master = master }));
        return mod;
    }

    private static async Task<string?> DivergenceWithOriginalMastersKeptAsync(Fallout4Mod original, Fallout4Mod recompiled)
    {
        using var scratch = new ScratchDirectory("medit-modelidentity-pruned-");
        var originalPath = Path.Combine(Directory.CreateDirectory(Path.Combine(scratch.Path, "original")).FullName, original.ModKey.FileName);
        await original.BeginWrite.ToPath(originalPath).WithLoadOrderFromHeaderMasters().WithNoDataFolder().NoMastersListContentCheck().WriteAsync();
        var recompiledPath = await Write(recompiled, Path.Combine(scratch.Path, "recompiled"));
        return Adapter.DivergenceFrom(
            original.ModKey.FileName, originalPath, recompiledPath, EmptyLoadOrder.Of(GameRelease.Fallout4),
            HandedStrings.Of(originalPath)).Answered();
    }

    private static void SetOpaqueHeaderFields(Fallout4Mod mod)
    {
        mod.ModHeader.INTV = new byte[] { 1, 0, 0, 0 };
        mod.ModHeader.INCC = 42;
        mod.ModHeader.TypeOffsets = new byte[] { 9, 8, 7 };
        mod.ModHeader.Deleted = new byte[] { 1, 2, 3 };
        mod.ModHeader.Screenshot = new byte[] { 4, 5, 6 };
        mod.ModHeader.Author = "Some Author";
        mod.ModHeader.Description = "Some Description";
        mod.ModHeader.TransientTypes.Add(new TransientType { FormType = 7 });
    }

    private static async Task<string> Write(Fallout4Mod mod, string folder)
    {
        var path = Path.Combine(Directory.CreateDirectory(folder).FullName, mod.ModKey.FileName);
        await mod.BeginWrite.ToPath(path).WithNoLoadOrder().WriteAsync();
        return path;
    }

    private static async Task<string?> DivergenceAsync(Fallout4Mod original, Fallout4Mod recompiled)
    {
        using var scratch = new ScratchDirectory("medit-modelidentity-");
        var originalPath = await Write(original, Path.Combine(scratch.Path, "original"));
        var recompiledPath = await Write(recompiled, Path.Combine(scratch.Path, "recompiled"));
        return Adapter.DivergenceFrom(
            original.ModKey.FileName, originalPath, recompiledPath, EmptyLoadOrder.Of(GameRelease.Fallout4),
            HandedStrings.Of(originalPath)).Answered();
    }

    private static async Task<(string? Divergence, byte[] OriginalBytes, byte[] RewrittenBytes)> ParseRewriteAndCompare(
        GeneratedPlugin plugin)
    {
        using var scratch = new ScratchDirectory("medit-modelidentity-");
        var fileName = plugin.FileName;
        plugin.WriteInto(scratch.Path);
        var originalPath = Path.Combine(scratch.Path, fileName);
        var original = Fallout4Mod.CreateFromBinary(
            new ModPath(ModKey.FromFileName(fileName), originalPath), Fallout4Release.Fallout4);

        var rewrittenPath = Path.Combine(Directory.CreateDirectory(Path.Combine(scratch.Path, "rewritten")).FullName, fileName);
        await original.BeginWrite
            .ToPath(rewrittenPath)
            .WithLoadOrderFromHeaderMasters()
            .WithNoDataFolder()
            .NoNextFormIDProcessing()
            .WithRecordCount(RecordCountOption.NoCheck)
            .WriteAsync();

        var divergence = Adapter.DivergenceFrom(
            fileName, originalPath, rewrittenPath, EmptyLoadOrder.Of(GameRelease.Fallout4), HandedStrings.Of(originalPath)).Answered();
        return (divergence, await File.ReadAllBytesAsync(originalPath), await File.ReadAllBytesAsync(rewrittenPath));
    }
}
