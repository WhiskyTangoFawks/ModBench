using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

public sealed class MakePatchPluginHandlerTests : IDisposable
{
    private const string Game = "Fallout4.esm";
    private const string Base = "Base.esm";
    private const string Coast = "Coast.esm";
    private const string Mod = "PatchMod";
    private const string Patch = "Patch.esp";

    private readonly Npc _npc;
    private readonly Cell _interior;
    private readonly PlacedObject _interiorRef;
    private readonly Worldspace _world;
    private readonly Cell _exterior;
    private readonly PlacedObject _exteriorRef;
    private readonly PlacedObject _persistentRef;
    private readonly Cell _gameCell;
    private readonly PlacedObject _gameCellRef;
    private readonly PlacedObject _gameGridRef;
    private readonly PluginFixtureData _data;
    private readonly LoadOrderHolder _holder = new();
    private readonly HandedWrites _index = HandedWrites.Create();
    private readonly string _folder;

    public MakePatchPluginHandlerTests()
    {
        (Npc Npc, SpatialPlugin.Records Spatial, Cell TopCell, PlacedObject PersistentRef)? made = null;
        (Cell Cell, PlacedObject Ref)? inGame = null;
        (Worldspace World, Cell Cell, PlacedObject Ref)? inGameWorld = null;
        _data = new PluginFixtureBuilder("make-patch-handler")
            .WithPlugin(Game, mod =>
            {
                var cell = new Cell(mod) { EditorID = "GameCell", Flags = Cell.Flag.IsInteriorCell, WaterHeight = 5 };
                var placed = new PlacedObject(mod) { EditorID = "GameCellRef" };
                cell.Temporary.Add(placed);
                mod.AddInteriorCells(cell);
                inGame = (cell, placed);

                var world = new Worldspace(mod) { EditorID = "GameWorld" };
                var gridCell = new Cell(mod) { EditorID = "GameGridCell", MajorRecordFlagsRaw = PersistentFlag.Bit, Grid = new CellGrid { Point = new P2Int(2, 3) } };
                var gridRef = new PlacedObject(mod) { EditorID = "GameGridRef" };
                gridCell.Persistent.Add(gridRef);
                world.SubCells.Add(CellBlocks.Exterior(gridCell));
                mod.Worldspaces.Add(world);
                inGameWorld = (world, gridCell, gridRef);
            })
            .WithPlugin(Base, mod =>
            {
                var spatial = SpatialPlugin.AddTo(mod);
                var topCell = new Cell(mod) { EditorID = "BaseTopCell" };
                var persistentRef = new PlacedObject(mod) { EditorID = "BasePersistentRef" };
                topCell.Persistent.Add(persistentRef);
                spatial.Worldspace.TopCell = topCell;
                made = (mod.Npcs.AddNew("BaseNpc"), spatial, topCell, persistentRef);
            })
            .WithPlugin(Coast, mod =>
            {
                var deleted = inGame.Require().Cell.DeepCopy();
                deleted.Temporary.Clear();
                deleted.WaterHeight = 7;
                deleted.IsCompressed = true;
                mod.AddInteriorCells(deleted);
            })
            .Build();
        (_gameCell, _gameCellRef) = inGame.Require();
        var coastPath = Path.Combine(_data.DataFolder, Coast);
        File.WriteAllBytes(coastPath, RawPlugin.WithRecordFlags(File.ReadAllBytes(coastPath), _gameCell.FormKey.ID, (uint)DeletedFlag.Bit));
        _index.Owners[_gameCell.FormKey.ToString()] = new PluginAddress(Coast, PluginOrigin.DataDirectory);
        _index.Owners[_gameCellRef.FormKey.ToString()] = new PluginAddress(Game, PluginOrigin.DataDirectory);
        var (gameWorld, gridCell, gridRef) = inGameWorld.Require();
        _gameGridRef = gridRef;
        foreach (var record in new IMajorRecordGetter[] { gameWorld, gridCell, gridRef })
            _index.Owners[record.FormKey.ToString()] = new PluginAddress(Game, PluginOrigin.DataDirectory);
        var (npc, spatial, topCell, persistentRef) = made.Require();
        (_npc, _interior, _interiorRef, _world, _exterior, _exteriorRef, _persistentRef) =
            (npc, spatial.InteriorCell, spatial.InteriorRef, spatial.Worldspace, spatial.ExteriorCell, spatial.ExteriorRef, persistentRef);
        foreach (var record in new IMajorRecordGetter[] { npc, _interior, _interiorRef, _world, _exterior, _exteriorRef, topCell, persistentRef })
            _index.Owners[record.FormKey.ToString()] = new PluginAddress(Base, PluginOrigin.DataDirectory);

        _folder = Directory.CreateDirectory(Path.Combine(_data.InstanceRoot, Mod)).FullName;
        _holder.Apply(SnapshotPlugins.Snapshot(
            _data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4, _data.Plugins, [new PluginPlace(Mod, _folder, null)]));
    }

    public void Dispose() => _data.Dispose();

    private MakePatchPluginHandler Handler => HandlerOver(TestAdapters.Mutagen());

    private readonly InMemoryNotificationPublisher _pushed = new();

    private MakePatchPluginHandler HandlerOver(IPluginAdapter adapter) =>
        TestEditService.Over(_holder, adapter: adapter, notifications: _pushed, index: _index.Queries).GetRequiredService<MakePatchPluginHandler>();

    private sealed class MissingTheFileThatLandsAfterTheCheck(IPluginAdapter inner) : DelegatingPluginAdapter(inner)
    {
        private bool _checked;

        public override string? HeldAt(string pluginPath)
        {
            if (_checked) return base.HeldAt(pluginPath);
            _checked = true;
            return null;
        }
    }

    private static GivenRecord Given(IMajorRecordGetter record, string? recordType = null) =>
        new(RecordTextCodec.SerializeToText(record, GameRelease.Fallout4), recordType);

    private string PatchPath => Path.Combine(_folder, Patch);

    private IFallout4ModDisposableGetter Written() =>
        Fallout4Mod.CreateFromBinaryOverlay(new ModPath(ModKey.FromFileName(Patch), PatchPath), Fallout4Release.Fallout4);

    private static IEnumerable<ICellGetter> InteriorCellsOf(IFallout4ModGetter mod) =>
        mod.Cells.Records.SelectMany(block => block.SubBlocks).SelectMany(subBlock => subBlock.Cells);

    private static IEnumerable<ICellGetter> ExteriorCellsOf(IFallout4ModGetter mod) =>
        mod.Worldspaces.SelectMany(world => world.SubCells).SelectMany(block => block.Items).SelectMany(subBlock => subBlock.Items);

    [Fact]
    public async Task RecordsGiven_LandInThePluginWritten_EachInTheContainersItsWinningCopySitsIn_AndTheRecordIndexReadsItBack()
    {
        var renamed = _npc.DeepCopy();
        renamed.EditorID = "PatchedNpc";

        var made = await Handler.Make(Mod, Patch, [], [Given(renamed), Given(_interiorRef), Given(_exteriorRef)]);

        Assert.True(made.Holds(out var patch, out var refused), refused?.Message);
        using var written = Written();
        var interior = Assert.Single(InteriorCellsOf(written));
        var world = Assert.Single(written.Worldspaces);
        var exterior = ExteriorCellsOf(written).Single();
        Assert.Equal(
            ("PatchedNpc", _interior.FormKey, _interiorRef.FormKey, _world.FormKey, _exterior.FormKey, _exteriorRef.FormKey, Base),
            (written.Npcs.Single().EditorID, interior.FormKey, interior.Persistent.Single().FormKey, world.FormKey, exterior.FormKey,
                exterior.Persistent.Single().FormKey, string.Join(", ", written.ModHeader.MasterReferences.Select(master => master.Master.FileName))));
        Assert.Equal([HandedPlugin.ReadBack(patch.Plugin)], Assert.Single(_index.Hands).Require());
    }

    [Fact]
    public async Task ARefWhoseCellsWinningCopyIsDeletedAndCompressed_LandsInAPartialFormOfTheCell_ThatOverridesNoneOfItsFields()
    {
        var made = await Handler.Make(Mod, Patch, [], [Given(_gameCellRef)]);

        Assert.True(made.Holds(out _, out var refused), refused?.Message);
        using var written = Written();
        var cell = Assert.Single(InteriorCellsOf(written));
        Assert.Equal(
            (_gameCell.FormKey, PartialFormFlag.Bit, default(Cell.Flag), (float?)null, _gameCellRef.FormKey),
            (cell.FormKey, cell.MajorRecordFlagsRaw, cell.Flags, cell.WaterHeight, cell.Temporary.Single().FormKey));
    }

    [Fact]
    public async Task ARefInAPersistentCellInAGridBlock_LandsInAPartialFormOfTheCell_ThatKeepsItsGrid()
    {
        var made = await Handler.Make(Mod, Patch, [], [Given(_gameGridRef)]);

        Assert.True(made.Holds(out _, out var refused), refused?.Message);
        using var written = Written();
        var cell = Assert.Single(ExteriorCellsOf(written));
        Assert.Equal(
            (PersistentFlag.Bit | PartialFormFlag.Bit, new P2Int(2, 3), _gameGridRef.FormKey),
            (cell.MajorRecordFlagsRaw, cell.Grid?.Point, cell.Persistent.Single().FormKey));
    }

    [Fact]
    public async Task ARecordAsATypeOtherThanTheOneItIs_IsRefused_NamingTheRecordAndBothTypes()
    {
        var made = await Handler.Make(Mod, Patch, [], [Given(_npc, "refr")]);

        Assert.False(made.Holds(out _, out var refused));
        Assert.Equal(
            $"{_npc.FormKey} is a npc_ in {Base}, not the refr given.",
            refused.Message);
    }

    [Fact]
    public async Task ANewPlacedRecordGivenAlone_IsRefused_SayingToGiveItInsideItsContainersDocument()
    {
        var placed = new PlacedObject(FormKey.Factory($"000800:{Patch}"), Fallout4Release.Fallout4);

        var made = await Handler.Make(Mod, Patch, [], [Given(placed, "refr")]);

        Assert.False(made.Holds(out _, out var refused));
        Assert.Equal(
            new PatchRefused.OfRecord(
                RecordEditRefusal.ContainerUnknown,
                $"No active or compiled plugin's copy of 000800:{Patch} says which container it lives in. Give it inside its container's document."),
            refused);
    }

    [Fact]
    public async Task ANewPlacedRecord_EmbeddedInTheDocumentOfTheCellGiven_LandsInThatCell()
    {
        var withNew = _interior.DeepCopy();
        withNew.Persistent.Add(new PlacedObject(FormKey.Factory($"000800:{Patch}"), Fallout4Release.Fallout4));

        var made = await Handler.Make(Mod, Patch, [], [Given(withNew)]);

        Assert.True(made.Holds(out _, out var refused), refused?.Message);
        using var written = Written();
        Assert.Equal(
            new HashSet<FormKey> { _interiorRef.FormKey, FormKey.Factory($"000800:{Patch}") },
            Assert.Single(InteriorCellsOf(written)).Persistent.Select(placed => placed.FormKey).ToHashSet());
    }

    [Fact]
    public async Task RecordsNoPluginHolds_LandAsTheTypesGiven_ACellWithNoGridAsAnInteriorCell()
    {
        var types = RecordTypes.For(GameRelease.Fallout4);
        var npc = new Npc(FormKey.Factory($"000800:{Patch}"), Fallout4Release.Fallout4) { EditorID = "PatchNpc" };
        var cell = new Cell(FormKey.Factory($"000801:{Patch}"), Fallout4Release.Fallout4) { EditorID = "PatchCell", Flags = Cell.Flag.IsInteriorCell };

        var made = await Handler.Make(Mod, Patch, [], [Given(npc, types.RecordTypeOf(npc)), Given(cell, types.RecordTypeOf(cell))]);

        Assert.True(made.Holds(out _, out var refused), refused?.Message);
        using var written = Written();
        Assert.Equal(("PatchNpc", "PatchCell"), (written.Npcs.Single().EditorID, InteriorCellsOf(written).Single().EditorID));
    }

    [Fact]
    public async Task ARecordTheCodecWouldWriteOtherwise_IsRefusedAsCompileRefuses_InTheWordsOfAMake()
    {
        var sparse = new GivenRecord($$"""{"FormKey": "000800:{{Patch}}", "EditorID": "Sparse"}""", "npc_");

        var made = await Handler.Make(Mod, Patch, [], [sparse]);

        Assert.False(made.Holds(out _, out var refused));
        var compiled = Assert.IsType<PatchRefused.AsCompile>(refused);
        Assert.Equal(
            (CompileRefusal.SourceDoesNotParse, $"{Patch} cannot be made: 000800:{Patch}: "),
            (compiled.Refusal, compiled.Message[..$"{Patch} cannot be made: 000800:{Patch}: ".Length]));
    }

    [Fact]
    public async Task ARecordWhoseContainerGivenAlreadyHoldsItsSlot_IsRefused_AsRecordsThatDoNotRead()
    {
        var made = await Handler.Make(Mod, Patch, [], [Given(_world), Given(_persistentRef)]);

        Assert.False(made.Holds(out _, out var refused));
        var compiled = Assert.IsType<PatchRefused.AsCompile>(refused);
        var unread = $"{Patch} could not be read from the records given: ";
        Assert.Equal((CompileRefusal.SourceDoesNotParse, unread), (compiled.Refusal, compiled.Message[..unread.Length]));
    }

    [Fact]
    public async Task ACellMutagenWritesAsBytesItCannotReadBack_IsRefused_AndWritesNothing()
    {
        var deletedCompressed = _interior.DeepCopy();
        deletedCompressed.MajorRecordFlagsRaw = (int)DeletedFlag.Bit;
        deletedCompressed.IsCompressed = true;

        var made = await Handler.Make(Mod, Patch, [], [Given(deletedCompressed)]);

        Assert.False(made.Holds(out _, out var refused));
        var compiled = Assert.IsType<PatchRefused.AsCompile>(refused);
        var unread = $"{Patch} cannot be made: the plugin written from the records given does not read back, so nothing was written: ";
        Assert.Equal(
            (CompileRefusal.SourceValueDropped, unread, false),
            (compiled.Refusal, compiled.Message[..unread.Length], File.Exists(PatchPath)));
    }

    [Theory]
    [InlineData(Patch)]
    [InlineData("patch.ESP")]
    public async Task AFileLandingAtThePathWhileThePluginIsMade_IsLeft_AndRefusesTheMake(string landed)
    {
        await File.WriteAllTextAsync(Path.Combine(_folder, landed), "landed");

        var made = await HandlerOver(new MissingTheFileThatLandsAfterTheCheck(TestAdapters.Mutagen())).Make(Mod, Patch, [], [Given(_npc)]);

        Assert.False(made.Holds(out _, out var refused));
        Assert.Equal(
            (new PatchRefused.AsCreate(PluginCreateRefusal.FileExists, $"{_folder} already holds {landed}, so {Patch} was not made."), "landed"),
            (refused, await File.ReadAllTextAsync(Path.Combine(_folder, landed))));
    }

    [Theory]
    [InlineData(Patch)]
    [InlineData("patch.ESP")]
    public async Task Replacing_AFileAtItsPath_WritesThePlugin_AndSetsTheFileAside_NamingItOnThePush(string held)
    {
        await File.WriteAllTextAsync(Path.Combine(_folder, held), "held");

        var made = await Handler.Make(Mod, Patch, [], [Given(_npc)], replace: true);

        Assert.True(made.Holds(out _, out var refused), refused?.Message);
        using var written = Written();
        var setAside = Assert.IsType<FilesSetAsideNotification>(Assert.Single(_pushed.Notifications));
        var aside = Assert.Single(setAside.Paths);
        Assert.Equal(
            (_folder, held, "held", _npc.FormKey, Patch),
            (setAside.Folder, Path.GetFileName(aside), await File.ReadAllTextAsync(Path.Combine(_folder, aside)), written.Npcs.Single().FormKey,
                string.Join(", ", Directory.GetFiles(_folder).Select(Path.GetFileName))));
    }

    [Fact]
    public async Task AFileSetAsideByAnEarlierMake_IsNamedAgainByTheNextMakeInItsFolder()
    {
        await File.WriteAllTextAsync(PatchPath, "held");
        await Handler.Make(Mod, Patch, [], [Given(_npc)], replace: true);
        var earlier = Assert.IsType<FilesSetAsideNotification>(Assert.Single(_pushed.Notifications));

        var made = await Handler.Make(Mod, "Other.esp", [], [Given(_npc)]);

        Assert.True(made.Holds(out _, out var refused), refused?.Message);
        Assert.Equal(earlier.Paths, Assert.IsType<FilesSetAsideNotification>(_pushed.Notifications[^1]).Paths);
    }

    [Theory]
    [InlineData(CompileFixture.PluginName, "NoSuch.esp", false)]
    [InlineData(CompileFixture.PluginName, "NoSuch.esp", true)]
    [InlineData(CompileFixture.PluginName, CompileFixture.PluginName, false)]
    [InlineData("compile.esp", CompileFixture.PluginName, false)]
    public async Task APatchNamedAsACompiledPluginOfItsMod_IsRefusedNamingItsPluginSource_WithOrWithoutItsBinary_EvenAskedToReplace(
        string name, string deleted, bool replace)
    {
        using var compiled = new CompileFixture();
        File.Delete(Path.Combine(compiled.ModFolder, deleted));
        var holder = new LoadOrderHolder();
        holder.Apply(SnapshotPlugins.Snapshot(
            compiled.DataFolder, null, GameRelease.Fallout4, compiled.Entries,
            [new PluginPlace(CompileFixture.Origin, compiled.ModFolder, compiled.ModFolder)]));
        var heldBefore = string.Join(", ", Directory.GetFiles(compiled.ModFolder));

        var made = await TestEditService.Over(holder, index: compiled.Index.Queries).GetRequiredService<MakePatchPluginHandler>()
            .Make(CompileFixture.Origin, name, [], [], replace);

        Assert.False(made.Holds(out _, out var refused));
        Assert.Equal(
            (new PatchRefused.AsCreate(
                PluginCreateRefusal.CompiledPlugin,
                $"'{compiled.ModFolder}' holds plugin source for {name}, and its next compile would overwrite the plugin, so {name} was not made."),
                heldBefore),
            (refused, string.Join(", ", Directory.GetFiles(compiled.ModFolder))));
    }

    [Fact]
    public async Task AFileAtItsPathSpelledInAnotherCase_RefusesTheMake_NamingTheFileAsItIsSpelled()
    {
        await File.WriteAllTextAsync(Path.Combine(_folder, "patch.ESP"), "held");

        var made = await Handler.Make(Mod, Patch, [], [Given(_npc)]);

        Assert.False(made.Holds(out _, out var refused));
        Assert.Equal(
            (new PatchRefused.AsCreate(PluginCreateRefusal.FileExists, $"{_folder} already holds patch.ESP, so {Patch} was not made."), "patch.ESP", "held"),
            (refused, string.Join(", ", Directory.GetFiles(_folder).Select(Path.GetFileName)), await File.ReadAllTextAsync(Path.Combine(_folder, "patch.ESP"))));
    }

    [Fact]
    public async Task AMake_AsksTheRecordIndexWhoHoldsTheRecordsGiven_ThenTheContainersCarriedIn_ALayerAtATime()
    {
        var made = await Handler.Make(Mod, Patch, [], [Given(_npc), Given(_interiorRef), Given(_exteriorRef)]);

        Assert.True(made.Holds(out _, out var refused), refused?.Message);
        Assert.Equal(
            [[_npc.FormKey, _interiorRef.FormKey, _exteriorRef.FormKey], [_interior.FormKey, _exterior.FormKey], [_world.FormKey]],
            _index.OwnersAsked.Select(asked => asked.FormKeys.Select(formKey => FormKey.Factory(formKey))));
    }

    [Fact]
    public async Task EveryAskOfAMake_IsForTheLoadOrderTheMakeHolds_AndEachAfterTheFirst_CarriesItsDecision()
    {
        var made = await Handler.Make(Mod, Patch, [], [Given(_interiorRef)]);

        Assert.True(made.Holds(out _, out var refused), refused?.Message);
        var held = _holder.Held.Require().Version;
        Assert.Equal([(held, (long?)null), (held, 7)], _index.OwnersAsked.Select(asked => (asked.Version, asked.Decision)));
    }

    [Fact]
    public async Task ARecordTheRecordIndexCannotYetPlace_IsRefusedAsTheRecordIndexRefuses()
    {
        var notReady = new IndexRefused(IndexRefusal.IndexNotReady, "The record index is reading.");
        _index.OwnersRefused = notReady;

        var made = await Handler.Make(Mod, Patch, [], [Given(_interiorRef)]);

        Assert.False(made.Holds(out _, out var refused));
        Assert.Equal((new PatchRefused.OfIndex(notReady), false), (refused, File.Exists(PatchPath)));
    }

    [Theory]
    [InlineData(Giving.ARecordNoPluginHoldsWithNoType, "No active plugin and no compiled plugin holds 000800:Patch.esp, so its record type must be given.")]
    [InlineData(Giving.APlacedRecordWhoseCellNoPluginHolds, "No active plugin and no compiled plugin holds {0}, which holds a record given.")]
    [InlineData(Giving.AnExteriorCellNoPluginHolds, "No active plugin and no compiled plugin holds 000800:Patch.esp, an exterior cell, so which worldspace it sits in is unknown.")]
    public async Task ARecordNoActiveOrCompiledPluginHolds_IsRefusedSayingSo_SinceAnInactivePluginMayHoldIt(Giving giving, string expected)
    {
        var (origin, name, flags, records) = Making(giving);

        var made = await Handler.Make(origin, name, flags, records);

        Assert.False(made.Holds(out _, out var refused));
        Assert.Equal(string.Format(System.Globalization.CultureInfo.InvariantCulture, expected, _interior.FormKey), refused.Message);
    }

    public enum Giving
    {
        AFileAtItsPath,
        ARecordNamingNoFormKey,
        ARecordTwice,
        ARecordTwiceInPluginNamesOfDifferentCase,
        ARecordNoPluginHoldsWithNoType,
        ANativeFormIdOutsideTheLightRange,
        ARecordAsNoRecordType,
        APlacedRecordWhoseCellNoPluginHolds,
        AnExteriorCellWithNoGrid,
        AnExteriorCellNoPluginHolds,
        ANameThatIsNoPluginFile,
        AnOriginThatIsNoEnabledMod,
        ARecordTheRecordIndexNamesAPluginNotHolding,
        ARecordWhosePluginCannotBeRead,
    }

    private (string Origin, string Name, IReadOnlyList<string> Flags, IReadOnlyList<GivenRecord> Records) Making(Giving giving)
    {
        switch (giving)
        {
            case Giving.AFileAtItsPath:
                File.WriteAllText(PatchPath, "held");
                return (Mod, Patch, [], [Given(_npc)]);
            case Giving.ARecordNamingNoFormKey:
                return (Mod, Patch, [], [new GivenRecord("{\"EditorID\": \"Nameless\"}", "npc_")]);
            case Giving.ARecordTwice:
                return (Mod, Patch, [], [Given(_npc), Given(_npc)]);
            case Giving.ARecordTwiceInPluginNamesOfDifferentCase:
                var given = Given(_npc);
                return (Mod, Patch, [], [given, given with { Text = given.Text.Replace($"\"{_npc.FormKey}\"", $"\"{_npc.FormKey.ToString().ToLowerInvariant()}\"", StringComparison.Ordinal) }]);
            case Giving.ARecordNoPluginHoldsWithNoType:
                return (Mod, Patch, [], [Given(new Npc(FormKey.Factory($"000800:{Patch}"), Fallout4Release.Fallout4))]);
            case Giving.ARecordAsNoRecordType:
                return (Mod, Patch, [], [Given(_npc, "nothing")]);
            case Giving.APlacedRecordWhoseCellNoPluginHolds:
                _index.Owners.Remove(_interior.FormKey.ToString());
                return (Mod, Patch, [], [Given(_interiorRef)]);
            case Giving.AnExteriorCellWithNoGrid:
                var gridless = _exterior.DeepCopy();
                gridless.Grid = null;
                return (Mod, Patch, [], [Given(gridless)]);
            case Giving.AnOriginThatIsNoEnabledMod:
                return ("No Such Mod", Patch, [], [Given(_npc)]);
            case Giving.ANameThatIsNoPluginFile:
                return (Mod, "Patch.txt", [], [Given(_npc)]);
            case Giving.AnExteriorCellNoPluginHolds:
                var cellType = RecordTypes.For(GameRelease.Fallout4).RecordTypeOf(_exterior);
                return (Mod, Patch, [], [Given(new Cell(FormKey.Factory($"000800:{Patch}"), Fallout4Release.Fallout4) { Grid = new CellGrid() }, cellType)]);
            case Giving.ARecordTheRecordIndexNamesAPluginNotHolding:
                _index.Owners[_npc.FormKey.ToString()] = new PluginAddress("Gone.esp", PluginOrigin.DataDirectory);
                return (Mod, Patch, [], [Given(_npc)]);
            case Giving.ARecordWhosePluginCannotBeRead:
                File.WriteAllText(Path.Combine(_data.DataFolder, Base), "no plugin");
                return (Mod, Patch, [], [Given(_interiorRef)]);
            case Giving.ANativeFormIdOutsideTheLightRange:
                return (Mod, "Patch.esl", ["Master", "Small"], [Given(new Npc(FormKey.Factory("0FF000:Patch.esl"), Fallout4Release.Fallout4), "npc_")]);
            default:
                throw new ArgumentOutOfRangeException(nameof(giving), giving, null);
        }
    }

    public static TheoryData<Giving, PatchRefused> Refusals => new()
    {
        { Giving.AFileAtItsPath, new PatchRefused.AsCreate(PluginCreateRefusal.FileExists, "") },
        { Giving.ARecordNamingNoFormKey, new PatchRefused.OfRecord(RecordEditRefusal.InvalidEnvelope, "") },
        { Giving.ARecordTwice, new PatchRefused.AsCompile(CompileRefusal.FormKeyCollision, "") },
        { Giving.ARecordTwiceInPluginNamesOfDifferentCase, new PatchRefused.AsCompile(CompileRefusal.FormKeyCollision, "") },
        { Giving.ARecordNoPluginHoldsWithNoType, new PatchRefused.OfRecord(RecordEditRefusal.RecordTypeNotFound, "") },
        { Giving.ANativeFormIdOutsideTheLightRange, new PatchRefused.AsCompile(CompileRefusal.FormIdOutsideFlagLimit, "") },
        { Giving.ARecordAsNoRecordType, new PatchRefused.OfRecord(RecordEditRefusal.RecordTypeNotFound, "") },
        { Giving.APlacedRecordWhoseCellNoPluginHolds, new PatchRefused.OfRecord(RecordEditRefusal.ContainerUnknown, "") },
        { Giving.AnExteriorCellWithNoGrid, new PatchRefused.OfRecord(RecordEditRefusal.ContainerUnknown, "") },
        { Giving.AnExteriorCellNoPluginHolds, new PatchRefused.OfRecord(RecordEditRefusal.ContainerUnknown, "") },
        { Giving.ANameThatIsNoPluginFile, new PatchRefused.AsCreate(PluginCreateRefusal.NotAPluginFile, "") },
        { Giving.AnOriginThatIsNoEnabledMod, new PatchRefused.AsCreate(PluginCreateRefusal.OriginNotAMod, "") },

        { Giving.ARecordTheRecordIndexNamesAPluginNotHolding, new PatchRefused.OfRecord(RecordEditRefusal.RecordNotFound, "") },
        { Giving.ARecordWhosePluginCannotBeRead, new PatchRefused.OfRecord(RecordEditRefusal.RecordParseFailed, "") },
    };

    [Theory]
    [MemberData(nameof(Refusals))]
    public async Task Making_IsRefused_AndWritesNothing(Giving giving, PatchRefused expected)
    {
        var (origin, name, flags, records) = Making(giving);
        var heldBefore = string.Join(", ", Directory.GetFiles(_folder));

        var made = await Handler.Make(origin, name, flags, records);

        Assert.False(made.Holds(out _, out var refused));
        Assert.Equal((expected with { Message = "" }, heldBefore), (refused with { Message = "" }, string.Join(", ", Directory.GetFiles(_folder))));
    }
}
