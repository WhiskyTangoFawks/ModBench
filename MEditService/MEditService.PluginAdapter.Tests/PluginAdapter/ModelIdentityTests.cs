using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class ModelIdentityTests
{
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private static readonly ModKey Fixture = ModKey.FromFileName("Fixture.esp");

    private static Fallout4Mod NewMod() => new(Fixture, Fallout4Release.Fallout4);

    /// <summary>Each pair a recompile might write, and what the divergence names: null when the pair is model-identical.</summary>
    public static TheoryData<string, Func<(Fallout4Mod Original, Fallout4Mod Recompiled)>, string?> Recompiles => new()
    {
        { "a float that differs", () => (NpcWith(npc => npc.HeightMin = 1.5f), NpcWith(npc => npc.HeightMin = 2.5f)), "field 'HeightMin' changed" },
        { "a float that differs within the epsilon of Mutagen's equals mask", () => (NpcWith(npc => npc.HeightMin = 0f), NpcWith(npc => npc.HeightMin = 5e-10f)), "field 'HeightMin' changed" },
        { "a worldspace's blocks, sub-blocks and cells in another order, which the tree carries none of", WorldspaceBlocksInAnotherOrder, null },
        { "a cell under a worldspace block that differs", () => (WorldspaceOfACell(0, 0, 0), WorldspaceOfACell(0, 0, 1)), "Point" },
        { "a cell under another block coordinate, which only the worldspace's own comparison guards", () => (WorldspaceOfACell(0, 0, 0), WorldspaceOfACell(5, 0, 0)), "BlockNumberX" },
        { "a quest's topics and a topic's responses in another order, as the format files them by name", QuestTopicsInAnotherOrder, null },
        { "a topic in another quest", ATopicInAnotherQuest, "Quest 000800:Fixture.esp" },
        { "only an interior cell's group header fields", AnInteriorCellsStamps, null },
        { "only a worldspace's top cell's group header fields", AWorldspacesTopCellsStamps, null },
        { "only a worldspace block's group header fields", AWorldspaceBlocksStamps, null },
        { "only a quest's nested topic's group header fields", AQuestsNestedTopicsStamps, null },
        { "the header's allow-listed fields alike", () => (WithHeader(SetOpaqueHeaderFields), WithHeader(SetOpaqueHeaderFields)), null },
        { "the header's TypeOffsets", () => (WithHeader(h => h.TypeOffsets = new byte[] { 1, 2, 3 }), WithHeader(h => h.TypeOffsets = new byte[] { 9, 9, 9 })), "'TypeOffsets'" },
        { "the header's Deleted", () => (WithHeader(h => h.Deleted = new byte[] { 1, 2, 3 }), WithHeader(h => h.Deleted = new byte[] { 9, 9, 9 })), "'Deleted'" },
        { "the header's Screenshot", () => (WithHeader(h => h.Screenshot = new byte[] { 1, 2, 3 }), WithHeader(h => h.Screenshot = new byte[] { 9, 9, 9 })), "'Screenshot'" },
        { "the header's INTV", () => (WithHeader(h => h.INTV = new byte[] { 1, 0, 0, 0 }), WithHeader(h => h.INTV = new byte[] { 99, 0, 0, 0 })), "'INTV'" },
        { "the header's INCC", () => (WithHeader(h => h.INCC = 1), WithHeader(h => h.INCC = 2)), "'INCC'" },
        { "the header's Author", () => (WithHeader(h => h.Author = "Original"), WithHeader(h => h.Author = "Corrupted")), "'Author'" },
        { "the header's Description", () => (WithHeader(h => h.Description = "Original"), WithHeader(h => h.Description = "Corrupted")), "'Description'" },
        {
            "an item of the header's TransientTypes",
            () => (WithHeader(h => h.TransientTypes.Add(new TransientType { FormType = 7 })), WithHeader(h => h.TransientTypes.Add(new TransientType { FormType = 99 }))),
            "'TransientTypes'"
        },
        { "the count of the header's TransientTypes", () => (WithHeader(h => h.TransientTypes.Add(new TransientType { FormType = 7 })), NewMod()), "'TransientTypes'" },
        { "only a header field the verdict excludes", () => (WithHeader(h => h.Flags = Fallout4ModHeader.HeaderFlag.Localized), NewMod()), null },
        { "a gendered item's sub-field", () => (ArmorOfWorldModel("male.nif"), ArmorOfWorldModel("DIFFERENT.nif")), "Armor 000800:Fixture.esp" },
        { "a package data int's value", () => (PackageOfAnInt(1), PackageOfAnInt(99)), "field 'Data[0].Data' changed" },
        { "the text of a string in a plugin not localized", () => (DoorNamed("Door"), DoorNamed("Gate")), "field 'Name' changed" },
        { "an ordered key-and-value-shaped list reordered, a real content change", () => (NpcOfMorphs(1, 2), NpcOfMorphs(2, 1)), "Npc 000800:Fixture.esp" },
        { "a list the format sorts, in its order", () => (NpcInFactions(0x802, 0x801), NpcInFactions(0x801, 0x802)), null },
        { "a list the format does not sort, in another order", () => (NpcOfKeywords(0x802, 0x801), NpcOfKeywords(0x801, 0x802)), "field 'Keywords' changed" },
        { "only a member the format omits", () => (RecipeOfAConditionPad(0x1D), RecipeOfAConditionPad(0)), null },
        { "a FormKey whose plugin name differs only in case", () => (HeadPart("Upper.esp", 0x817), HeadPart("UPPER.ESP", 0x817)), null },
        { "a FormKey's id", () => (HeadPart("Upper.esp", 0x817), HeadPart("Upper.esp", 0x818)), "Npc 000800:Fixture.esp" },
        { "a FormKey's plugin beyond case", () => (HeadPart("Upper.esp", 0x817), HeadPart("Other.esp", 0x817)), "Npc 000800:Fixture.esp" },
        { "a string None in another case", () => (ScriptString("None"), ScriptString("none")), "Npc 000800:Fixture.esp" },
        { "a FormKey string with leading whitespace", () => (ScriptString("000817:Upper.esp"), ScriptString(" 000817:Upper.esp")), "Npc 000800:Fixture.esp" },
        { "a FormKey string with an underscore for the colon", () => (ScriptString("000817:Upper.esp"), ScriptString("000817_Upper.esp")), "Npc 000800:Fixture.esp" },
        { "a FormKey string's id in another hex case", () => (ScriptString("00081D:Upper.esp"), ScriptString("00081d:Upper.esp")), "Npc 000800:Fixture.esp" },
    };

    [Theory]
    [MemberData(nameof(Recompiles))]
    public async Task DivergenceFrom_NamesWhatARecompileChanged_AndNothingItsFormatNormalizes(
        string _, Func<(Fallout4Mod Original, Fallout4Mod Recompiled)> mods, string? named)
    {
        var (original, recompiled) = mods();

        var divergence = await DivergenceAsync(original, recompiled);

        Assert.Equal(named is not null, divergence is not null);
        Assert.Contains(named ?? "", divergence ?? "", StringComparison.Ordinal);
    }

    private static readonly ModKey UnreferencedMaster = ModKey.FromFileName("Unreferenced.esm");
    private static readonly FormKey PerkInLastMaster = new(ModKey.FromFileName("Perks.esm"), 0x800);

    public static TheoryData<string, Func<(Fallout4Mod Original, Fallout4Mod Recompiled)>, string?> MastersPruned => new()
    {
        {
            "a condition's perk parameter the function reads",
            () => (PluginWithARecipeCondition(HasPerk(PerkInLastMaster), UnreferencedMaster, PerkInLastMaster.ModKey), PluginWithARecipeCondition(HasPerk(PerkInLastMaster))),
            null
        },
        {
            "a condition's parameter a record would name, which the function does not read",
            () => (PluginWithARecipeCondition(ConditionData(Condition.Function.IsAttacking, 0x0100_0800, FormKey.Null), UnreferencedMaster, PerkInLastMaster.ModKey),
                PluginWithARecipeCondition(ConditionData(Condition.Function.IsAttacking, 0x0100_0800, FormKey.Null))),
            null
        },
        { "a condition in a dialog topic's response", () => (PluginWithATopicCondition(UnreferencedMaster, PerkInLastMaster.ModKey), PluginWithATopicCondition()), null },
        {
            "a condition's form parameter naming another record",
            () => (PluginWithARecipeCondition(HasPerk(PerkInLastMaster), UnreferencedMaster, PerkInLastMaster.ModKey),
                PluginWithARecipeCondition(HasPerk(new FormKey(PerkInLastMaster.ModKey, 0x801)))),
            "ParameterOneRecord"
        },
    };

    [Theory]
    [MemberData(nameof(MastersPruned))]
    public async Task DivergenceFrom_WhenARecompilePrunesAMaster_IsBlindToTheRenumbering_AndNamesARecordChanged(
        string _, Func<(Fallout4Mod Original, Fallout4Mod Recompiled)> mods, string? named)
    {
        var (original, recompiled) = mods();

        var divergence = await DivergenceWithOriginalMastersKeptAsync(original, recompiled);

        Assert.Equal(named is not null, divergence is not null);
        Assert.Contains(named ?? "", divergence ?? "", StringComparison.Ordinal);
    }

    [Fact]
    public async Task DivergenceFrom_OfAPluginWhoseRecordsAreRedeflatedAndHoldANegativeZero_ReturnsNull()
    {
        var (divergence, originalBytes, rewrittenBytes) = await ParseRewriteAndCompare(NegativeZeroPlugin.Plugin);

        Assert.False(RawPlugin.FirstMiscZlibHeader(originalBytes).SequenceEqual(RawPlugin.FirstMiscZlibHeader(rewrittenBytes)),
            "The rewrite does not re-deflate the generated plugin's records — this test does not exercise the re-deflate it depends on.");
        Assert.Null(divergence);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DivergenceFrom_OfADeletedReferenceHoldingItsBaseRecord_ReturnsNull_BecauseMutagenWritesADeletedRecordAsItsHeaderAlone(bool trap)
    {
        var bytes = trap ? DeletedReferencePlugin.TrapBytes("Fixture.esp") : DeletedReferencePlugin.Bytes("Fixture.esp");

        var (divergence, _, _) = await ParseRewriteAndCompare(new GeneratedPlugin("Fixture.esp", bytes));

        Assert.Null(divergence);
    }

    private static (Fallout4Mod, Fallout4Mod) WorldspaceBlocksInAnotherOrder()
    {
        var mod = NewMod();
        var ws = mod.Worldspaces.AddNew("TestWs");
        var cellA = new Cell(mod) { EditorID = "CellA", Grid = new CellGrid { Point = new P2Int(0, 0) } };
        var cellB = new Cell(mod) { EditorID = "CellB", Grid = new CellGrid { Point = new P2Int(1, 0) } };
        var cellC = new Cell(mod) { EditorID = "CellC", Grid = new CellGrid { Point = new P2Int(8, 8) } };
        ws.SubCells.Add(Block(0, 0, SubBlock(0, 0, cellA, cellB)));
        ws.SubCells.Add(Block(1, 1, SubBlock(2, 2, cellC)));

        var recompiled = NewMod();
        var recompiledWs = new Worldspace(ws.FormKey, Fallout4Release.Fallout4) { EditorID = "TestWs" };
        recompiledWs.SubCells.Add(Block(1, 1, SubBlock(2, 2, cellC.DeepCopy())));
        recompiledWs.SubCells.Add(Block(0, 0, SubBlock(0, 0, cellB.DeepCopy(), cellA.DeepCopy())));
        recompiled.Worldspaces.Add(recompiledWs);
        return (mod, recompiled);
    }

    private static Fallout4Mod WorldspaceOfACell(short blockX, short pointX, short pointY)
    {
        var mod = NewMod();
        var ws = new Worldspace(new FormKey(Fixture, 0x800), Fallout4Release.Fallout4) { EditorID = "TestWs" };
        var cell = new Cell(new FormKey(Fixture, 0x801), Fallout4Release.Fallout4) { EditorID = "CellA", Grid = new CellGrid { Point = new P2Int(pointX, pointY) } };
        ws.SubCells.Add(Block(blockX, 0, SubBlock(0, 0, cell)));
        mod.Worldspaces.Add(ws);
        return mod;
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

    private static (Fallout4Mod Original, Quest Quest, DialogTopic First, DialogTopic Second) AQuestWithTwoTopicsOfTwoResponses()
    {
        var mod = NewMod();
        var quest = mod.Quests.AddNew("TestQuest");
        DialogTopic Topic(string editorId)
        {
            var topic = new DialogTopic(mod) { EditorID = editorId, Quest = quest.ToLink() };
            topic.Responses.Add(new DialogResponses(mod) { EditorID = editorId + "First" });
            topic.Responses.Add(new DialogResponses(mod) { EditorID = editorId + "Second" });
            quest.DialogTopics.Add(topic);
            return topic;
        }
        return (mod, quest, Topic("TopicA"), Topic("TopicB"));
    }

    private static (Fallout4Mod, Fallout4Mod) QuestTopicsInAnotherOrder()
    {
        var (original, quest, first, second) = AQuestWithTwoTopicsOfTwoResponses();

        var recompiled = NewMod();
        var recompiledQuest = (Quest)quest.DeepCopy();
        recompiledQuest.DialogTopics.Clear();
        recompiledQuest.DialogTopics.Add(second.DeepCopy());
        recompiledQuest.DialogTopics.Add(first.DeepCopy());
        recompiledQuest.DialogTopics[1].Responses.Reverse();
        recompiled.Quests.Add(recompiledQuest);
        return (original, recompiled);
    }

    private static (Fallout4Mod, Fallout4Mod) ATopicInAnotherQuest()
    {
        var (original, quest, first, _) = AQuestWithTwoTopicsOfTwoResponses();
        var other = original.Quests.AddNew("OtherQuest");

        var recompiled = NewMod();
        var recompiledQuest = (Quest)quest.DeepCopy();
        recompiledQuest.DialogTopics.RemoveAt(0);
        var recompiledOther = (Quest)other.DeepCopy();
        recompiledOther.DialogTopics.Add(first.DeepCopy());
        recompiled.Quests.Add(recompiledQuest);
        recompiled.Quests.Add(recompiledOther);
        return (original, recompiled);
    }

    private static (Fallout4Mod, Fallout4Mod) AnInteriorCellsStamps()
    {
        var mod = NewMod();
        var cell = new Cell(mod) { EditorID = "TestCell", Timestamp = 1, UnknownGroupData = 2 };
        var placed = new PlacedObject(mod);
        cell.Temporary.Add(placed);
        mod.AddInteriorCells(cell);

        var recompiled = NewMod();
        var recompiledCell = new Cell(cell.FormKey, Fallout4Release.Fallout4) { EditorID = "TestCell", Timestamp = 99, UnknownGroupData = 100 };
        recompiledCell.Temporary.Add(new PlacedObject(placed.FormKey, Fallout4Release.Fallout4));
        recompiled.AddInteriorCells(recompiledCell);
        return (mod, recompiled);
    }

    private static (Fallout4Mod, Fallout4Mod) AWorldspacesTopCellsStamps()
    {
        var mod = NewMod();
        var ws = mod.Worldspaces.AddNew("TestWs");
        var topCell = new Cell(mod) { Timestamp = 1, UnknownGroupData = 2 };
        var placed = new PlacedObject(mod);
        topCell.Temporary.Add(placed);
        ws.TopCell = topCell;

        var recompiled = NewMod();
        var recompiledWs = new Worldspace(ws.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "TestWs",
            TopCell = new Cell(topCell.FormKey, Fallout4Release.Fallout4) { Timestamp = 99, UnknownGroupData = 100 },
        };
        recompiledWs.TopCell.Temporary.Add(new PlacedObject(placed.FormKey, Fallout4Release.Fallout4));
        recompiled.Worldspaces.Add(recompiledWs);
        return (mod, recompiled);
    }

    private static (Fallout4Mod, Fallout4Mod) AWorldspaceBlocksStamps()
    {
        var mod = NewMod();
        var ws = mod.Worldspaces.AddNew("TestWs");
        ws.SubCells.Add(new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0, LastModified = 1, Unknown = 2 });

        var recompiled = NewMod();
        var recompiledWs = new Worldspace(ws.FormKey, Fallout4Release.Fallout4) { EditorID = "TestWs" };
        recompiledWs.SubCells.Add(new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0, LastModified = 99, Unknown = 100 });
        recompiled.Worldspaces.Add(recompiledWs);
        return (mod, recompiled);
    }

    private static (Fallout4Mod, Fallout4Mod) AQuestsNestedTopicsStamps()
    {
        var original = NewMod();
        var quest = original.Quests.AddNew("TestQuest");
        var topic = new DialogTopic(original) { Quest = quest.ToLink(), Timestamp = 140636, Unknown = 467 };
        var response = new DialogResponses(original);
        topic.Responses.Add(response);
        quest.DialogTopics.Add(topic);

        var recompiled = NewMod();
        var recompiledQuest = new Quest(quest.FormKey, Fallout4Release.Fallout4) { EditorID = "TestQuest" };
        var recompiledTopic = new DialogTopic(topic.FormKey, Fallout4Release.Fallout4) { Quest = quest.ToLink() };
        recompiledTopic.Responses.Add(new DialogResponses(response.FormKey, Fallout4Release.Fallout4));
        recompiledQuest.DialogTopics.Add(recompiledTopic);
        recompiled.Quests.Add(recompiledQuest);
        return (original, recompiled);
    }

    private static Fallout4Mod WithHeader(Action<Fallout4ModHeader> set)
    {
        var mod = NewMod();
        set(mod.ModHeader);
        return mod;
    }

    private static void SetOpaqueHeaderFields(Fallout4ModHeader header)
    {
        header.INTV = new byte[] { 1, 0, 0, 0 };
        header.INCC = 42;
        header.TypeOffsets = new byte[] { 9, 8, 7 };
        header.Deleted = new byte[] { 1, 2, 3 };
        header.Screenshot = new byte[] { 4, 5, 6 };
        header.Author = "Some Author";
        header.Description = "Some Description";
        header.TransientTypes.Add(new TransientType { FormType = 7 });
    }

    private static Fallout4Mod ArmorOfWorldModel(string file)
    {
        var mod = NewMod();
        mod.Armors.Add(new Armor(new FormKey(Fixture, 0x800), Fallout4Release.Fallout4)
        {
            EditorID = "GenderedArmor",
            WorldModel = new GenderedItem<ArmorModel?>(new ArmorModel { Model = new Model { File = file } }, null),
        });
        return mod;
    }

    private static Fallout4Mod PackageOfAnInt(uint value)
    {
        var mod = NewMod();
        var package = new Package(new FormKey(Fixture, 0x800), Fallout4Release.Fallout4) { EditorID = "IntPackage" };
        package.Data.Add(0, new PackageDataInt { Name = "Count", Data = value });
        mod.Packages.Add(package);
        return mod;
    }

    private static Fallout4Mod DoorNamed(string name)
    {
        var mod = NewMod();
        mod.Doors.Add(new Door(new FormKey(Fixture, 0x800), Fallout4Release.Fallout4) { EditorID = "Door", Name = name });
        return mod;
    }

    private static Fallout4Mod NpcOfMorphs(params byte[] keys) =>
        NpcWith(npc => npc.Morphs.AddRange(keys.Select(key => new NpcMorph { Key = key, Value = key / 4f })));

    private static Fallout4Mod NpcInFactions(params uint[] factions) => NpcWith(npc => npc.Factions.AddRange(
        factions.Select(id => new RankPlacement { Faction = new FormLink<IFactionGetter>(new FormKey(npc.FormKey.ModKey, id)) })));

    private static Fallout4Mod NpcOfKeywords(params uint[] keywords) => NpcWith(npc => npc.Keywords =
        [.. keywords.Select(id => new FormLink<IKeywordGetter>(new FormKey(npc.FormKey.ModKey, id)))]);

    private static Fallout4Mod RecipeOfAConditionPad(byte pad)
    {
        var mod = NewMod();
        mod.ConstructibleObjects.AddNew("Recipe").Conditions.Add(new ConditionFloat
        {
            Data = new FunctionConditionData { Function = Condition.Function.GetIsSex },
            Unknown1 = new MemorySlice<byte>([pad, pad, pad]),
        });
        return mod;
    }

    private static Fallout4Mod HeadPart(string plugin, uint id) =>
        NpcWith(npc => npc.HeadParts.Add(new FormLink<IHeadPartGetter>(new FormKey(ModKey.FromFileName(plugin), id))));

    private static Fallout4Mod ScriptString(string text) => NpcWith(npc => npc.VirtualMachineAdapter = new VirtualMachineAdapter
    {
        Scripts = [new ScriptEntry
        {
            Name = "Script",
            Properties = [new ScriptStringProperty { Name = "Text", Data = text }],
        }],
    });

    private static Fallout4Mod NpcWith(Action<Npc> set)
    {
        var mod = NewMod();
        var npc = new Npc(new FormKey(mod.ModKey, 0x800), Fallout4Release.Fallout4) { EditorID = "Npc" };
        set(npc);
        mod.Npcs.Add(npc);
        return mod;
    }

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
        var mod = NewMod();
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
            HandedStrings.Of(originalPath)).Answered()?.Description;
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
            HandedStrings.Of(originalPath)).Answered()?.Description;
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
            fileName, originalPath, rewrittenPath, EmptyLoadOrder.Of(GameRelease.Fallout4), HandedStrings.Of(originalPath)).Answered()?.Description;
        return (divergence, await File.ReadAllBytesAsync(originalPath), await File.ReadAllBytesAsync(rewrittenPath));
    }
}
