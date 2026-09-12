using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>A mod with two plugins is one deferral (ADR-0003): the marker names the mod
/// folder, not a plugin, so an unanswered question refuses edits on every plugin the mod holds.</summary>
public sealed class TwoPluginModDeferralTests : IDisposable
{
    private const string Origin = "TwoPluginMod";
    private const string PluginA = "A.esp";
    private const string PluginB = "B.esp";

    private readonly string _instanceRoot;
    private readonly string _modFolder;
    private readonly EditRecordHandler _editHandler;
    private readonly CompilePluginHandler _compileHandler;
    private readonly FormKey _npcA;
    private readonly FormKey _npcB;

    public TwoPluginModDeferralTests()
    {
        var holder = new LoadOrderHolder();
        _instanceRoot = Directory.CreateTempSubdirectory("medit-twoplugin-").FullName;
        _modFolder = Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;
        var gameDirectory = Directory.CreateDirectory(Path.Combine(_instanceRoot, "game")).FullName;

        var pathA = Path.Combine(_modFolder, PluginA);
        var modA = new Fallout4Mod(ModKey.FromFileName(PluginA), Fallout4Release.Fallout4);
        _npcA = modA.Npcs.AddNew("NpcA").FormKey;
        modA.WriteToBinary(pathA);

        var pathB = Path.Combine(_modFolder, PluginB);
        var modB = new Fallout4Mod(ModKey.FromFileName(PluginB), Fallout4Release.Fallout4);
        _npcB = modB.Npcs.AddNew("NpcB").FormKey;
        modB.WriteToBinary(pathB);

        var entries = new List<LoadOrderEntry>
        {
            new(PluginA, pathA, Origin, Slot: 0, Enabled: true, Winning: true),
            new(PluginB, pathB, Origin, Slot: 1, Enabled: true, Winning: true),
        };
        var loadOrder = new LoadOrderSnapshot(gameDirectory, _instanceRoot, GameRelease.Fallout4, SnapshotCopies.Of(entries));

        new TrackService(NullLogger<TrackService>.Instance, MutagenPluginAdapter.Instance)
            .TrackAsync(loadOrder, [new PluginKey(PluginA, Origin), new PluginKey(PluginB, Origin)], Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        holder.Apply(loadOrder);
        _editHandler = TestEditService.EditHandler(holder);
        _compileHandler = TestEditService.CompileHandler(holder);
    }

    public void Dispose() => Directory.Delete(_instanceRoot, recursive: true);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // Only A's bytes drift: B is refused for sharing the mod, not for a change of its own.
    private void RaiseExternalChangeOnA()
    {
        File.WriteAllBytes(Path.Combine(_modFolder, PluginA), "changed-by-xedit"u8.ToArray());
        ExternalChangeDeferral.Set(_modFolder, "unanswered");
    }

    [Fact]
    public void UnansweredDeferral_RefusesAnEditOnEveryPluginTheModHolds()
    {
        RaiseExternalChangeOnA();

        var resultA = _editHandler.Set(new PluginKey(PluginA, Origin), _npcA.ToString(), "HeightMax", Json("0.5"));
        var resultB = _editHandler.Set(new PluginKey(PluginB, Origin), _npcB.ToString(), "HeightMax", Json("0.5"));

        Assert.False(resultA.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, resultA.Refusal);
        Assert.False(resultB.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, resultB.Refusal);
    }

    [Fact]
    public void UnansweredDeferral_RefusesCompilingTheSiblingPlugin_LeavingItsBinaryUntouched()
    {
        RaiseExternalChangeOnA();
        var pathB = Path.Combine(_modFolder, PluginB);
        var bytesB = File.ReadAllBytes(pathB);

        var result = _compileHandler.Compile(new PluginKey(PluginB, Origin), new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Equal(bytesB, File.ReadAllBytes(pathB));
    }

    [Fact]
    public void ClearingTheDeferral_UnblocksBothPluginsAtOnce()
    {
        RaiseExternalChangeOnA();
        ExternalChangeDeferral.Clear(_modFolder);

        var resultA = _editHandler.Set(new PluginKey(PluginA, Origin), _npcA.ToString(), "HeightMax", Json("0.5"));
        var resultB = _editHandler.Set(new PluginKey(PluginB, Origin), _npcB.ToString(), "HeightMax", Json("0.5"));

        Assert.True(resultA.Applied, resultA.Message);
        Assert.True(resultB.Applied, resultB.Message);
    }
}
