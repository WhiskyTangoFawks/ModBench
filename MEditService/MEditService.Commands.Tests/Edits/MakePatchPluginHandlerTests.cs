using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
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
    private const string Base = "Base.esm";
    private const string Mod = "PatchMod";
    private const string Patch = "Patch.esp";

    private readonly Npc _npc;
    private readonly Cell _interior;
    private readonly PlacedObject _interiorRef;
    private readonly Worldspace _world;
    private readonly Cell _exterior;
    private readonly PlacedObject _exteriorRef;
    private readonly PluginFixtureData _data;
    private readonly LoadOrderHolder _holder = new();
    private readonly HandedWrites _index = HandedWrites.Create();
    private readonly string _folder;

    public MakePatchPluginHandlerTests()
    {
        (Npc Npc, SpatialPlugin.Records Spatial)? made = null;
        _data = new PluginFixtureBuilder("make-patch-handler")
            .WithPlugin(Base, mod => made = (mod.Npcs.AddNew("BaseNpc"), SpatialPlugin.AddTo(mod)))
            .Build();
        var (npc, spatial) = made.Require();
        (_npc, _interior, _interiorRef, _world, _exterior, _exteriorRef) =
            (npc, spatial.InteriorCell, spatial.InteriorRef, spatial.Worldspace, spatial.ExteriorCell, spatial.ExteriorRef);
        foreach (var record in new IMajorRecordGetter[] { npc, _interior, _interiorRef, _world, _exterior, _exteriorRef })
            _index.Owners[record.FormKey.ToString()] = new PluginAddress(Base, PluginOrigin.DataDirectory);

        _folder = Directory.CreateDirectory(Path.Combine(_data.InstanceRoot, Mod)).FullName;
        _holder.Apply(SnapshotPlugins.Snapshot(
            _data.DataFolder, _data.InstanceRoot, GameRelease.Fallout4, _data.Plugins, [new PluginPlace(Mod, _folder, null)]));
    }

    public void Dispose() => _data.Dispose();

    private MakePatchPluginHandler Handler => HandlerOver(TestAdapters.Mutagen());

    private MakePatchPluginHandler HandlerOver(IPluginAdapter adapter) =>
        TestEditService.Over(_holder, adapter: adapter, index: _index.Queries).GetRequiredService<MakePatchPluginHandler>();

    // A file that lands at the path after the make looked for one.
    private sealed class SeeingNoFile(IPluginAdapter inner) : DelegatingPluginAdapter(inner)
    {
        public override bool Exists(string pluginPath) => false;
    }

    private static GivenRecord Given(IMajorRecordGetter record, string? recordType = null) =>
        new(RecordTextCodec.SerializeToText(record, GameRelease.Fallout4), recordType);

    private string PatchPath => Path.Combine(_folder, Patch);

    private IFallout4ModDisposableGetter Written() =>
        Fallout4Mod.CreateFromBinaryOverlay(new ModPath(ModKey.FromFileName(Patch), PatchPath), Fallout4Release.Fallout4);

    private static IEnumerable<ICellGetter> InteriorCellsOf(IFallout4ModGetter mod) =>
        mod.Cells.Records.SelectMany(block => block.SubBlocks).SelectMany(subBlock => subBlock.Cells);

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
        var exterior = world.SubCells.SelectMany(block => block.Items).SelectMany(subBlock => subBlock.Items).Single();
        Assert.Equal(
            ("PatchedNpc", _interior.FormKey, _interiorRef.FormKey, _world.FormKey, _exterior.FormKey, _exteriorRef.FormKey, Base),
            (written.Npcs.Single().EditorID, interior.FormKey, interior.Persistent.Single().FormKey, world.FormKey, exterior.FormKey,
                exterior.Persistent.Single().FormKey, string.Join(", ", written.ModHeader.MasterReferences.Select(master => master.Master.FileName))));
        Assert.Equal([HandedPlugin.ReadBack(patch.Plugin)], Assert.Single(_index.Hands).Require());
    }

    [Fact]
    public async Task ARecordNoPluginHolds_LandsAsTheTypeGiven()
    {
        var fresh = new Npc(FormKey.Factory($"000800:{Patch}"), Fallout4Release.Fallout4) { EditorID = "PatchNpc" };

        var made = await Handler.Make(Mod, Patch, [], [Given(fresh, RecordTypes.For(GameRelease.Fallout4).RecordTypeOf(fresh))]);

        Assert.True(made.Holds(out _, out var refused), refused?.Message);
        using var written = Written();
        Assert.Equal("PatchNpc", written.Npcs.Single().EditorID);
    }

    [Fact]
    public async Task AFileLandingAtThePathWhileThePluginIsMade_IsLeft_AndRefusesTheMake()
    {
        await File.WriteAllTextAsync(PatchPath, "landed");

        var made = await HandlerOver(new SeeingNoFile(TestAdapters.Mutagen())).Make(Mod, Patch, [], [Given(_npc)]);

        Assert.False(made.Holds(out _, out var refused));
        Assert.Equal(
            (new PatchRefused.AsCreate(PluginCreateRefusal.FileExists, ""), "landed"),
            (refused with { Message = "" }, await File.ReadAllTextAsync(PatchPath)));
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

    public enum Giving
    {
        AFileAtItsPath,
        ARecordNamingNoFormKey,
        ARecordTwice,
        ARecordNoPluginHoldsWithNoType,
        APlacedRecordNoPluginHolds,
        ANativeFormIdOutsideTheLightRange,
    }

    private (string Name, IReadOnlyList<string> Flags, IReadOnlyList<GivenRecord> Records) Making(Giving giving)
    {
        var placedType = RecordTypes.For(GameRelease.Fallout4).RecordTypeOf(_interiorRef);
        switch (giving)
        {
            case Giving.AFileAtItsPath:
                File.WriteAllText(PatchPath, "held");
                return (Patch, [], [Given(_npc)]);
            case Giving.ARecordNamingNoFormKey:
                return (Patch, [], [new GivenRecord("{\"EditorID\": \"Nameless\"}", "npc_")]);
            case Giving.ARecordTwice:
                return (Patch, [], [Given(_npc), Given(_npc)]);
            case Giving.ARecordNoPluginHoldsWithNoType:
                return (Patch, [], [Given(new Npc(FormKey.Factory($"000800:{Patch}"), Fallout4Release.Fallout4))]);
            case Giving.APlacedRecordNoPluginHolds:
                return (Patch, [], [Given(new PlacedObject(FormKey.Factory($"000800:{Patch}"), Fallout4Release.Fallout4), placedType)]);
            case Giving.ANativeFormIdOutsideTheLightRange:
                return ("Patch.esl", ["Master", "Small"], [Given(new Npc(FormKey.Factory("0FF000:Patch.esl"), Fallout4Release.Fallout4), "npc_")]);
            default:
                throw new ArgumentOutOfRangeException(nameof(giving), giving, null);
        }
    }

    public static TheoryData<Giving, PatchRefused> Refusals => new()
    {
        { Giving.AFileAtItsPath, new PatchRefused.AsCreate(PluginCreateRefusal.FileExists, "") },
        { Giving.ARecordNamingNoFormKey, new PatchRefused.OfRecord(RecordEditRefusal.InvalidEnvelope, "") },
        { Giving.ARecordTwice, new PatchRefused.AsCompile(CompileRefusal.FormKeyCollision, "") },
        { Giving.ARecordNoPluginHoldsWithNoType, new PatchRefused.OfRecord(RecordEditRefusal.RecordTypeNotFound, "") },
        { Giving.APlacedRecordNoPluginHolds, new PatchRefused.OfRecord(RecordEditRefusal.ContainerUnknown, "") },
        { Giving.ANativeFormIdOutsideTheLightRange, new PatchRefused.AsCompile(CompileRefusal.FormIdOutsideFlagLimit, "") },
    };

    [Theory]
    [MemberData(nameof(Refusals))]
    public async Task Making_IsRefused_AndWritesNothing(Giving giving, PatchRefused expected)
    {
        var (name, flags, records) = Making(giving);
        var heldBefore = string.Join(", ", Directory.GetFiles(_folder));

        var made = await Handler.Make(Mod, name, flags, records);

        Assert.False(made.Holds(out _, out var refused));
        Assert.Equal((expected with { Message = "" }, heldBefore), (refused with { Message = "" }, string.Join(", ", Directory.GetFiles(_folder))));
    }
}
