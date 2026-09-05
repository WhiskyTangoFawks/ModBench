using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>A non-string JSON value for a nullable FormLink column is the one malformed shape
/// <c>ValidateFormLinks</c> lets through: <c>CheckErrorBuilder</c> reads a non-string as "no
/// reference".</summary>
public sealed class ScalarFieldApplierRefusalTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string NpcBody() => _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;

    // ── converter-declined scalar values ───────────────────────────────────────

    [Fact]
    public void HeightMaxFloatColumn_NonNumericString_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("\"tall\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("HeightMax", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    [Fact]
    public void FlagsColumn_ArbitraryString_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "Flags", Json("\"NotANumber\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("Flags", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    [Fact]
    public void AggressionEnumColumn_UnrecognisedMemberName_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "Aggression", Json("\"NotARealAggressionLevel\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("Aggression", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    [Fact]
    public void EnergyLevelByteColumn_OutOfRangeValue_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "EnergyLevel", Json("4096"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("EnergyLevel", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    [Fact]
    public void HeightMaxFloatColumn_ValidValue_StillReportsApplied()
    {
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("0.75", NpcBody(), StringComparison.Ordinal);
    }

    // ── missing property on this record's own runtime type ────────────────────

    [Fact]
    public void OutputCharColumn_OnGlobalShortInstance_IsRefusedAsFieldNotFound()
    {
        using var glob = new GlobFixture();
        var before = glob.Body();

        var result = glob.Service().EditField(glob.Plugin, glob.GlobalShort.ToString(), "OutputChar", Json("true"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal(before, glob.Body());
    }

    [Fact]
    public void OutputCharColumn_OnGlobalFloatInstance_StillReportsApplied()
    {
        using var glob = new GlobFixture();

        var result = glob.Service().EditField(glob.Plugin, glob.GlobalFloat.ToString(), "OutputChar", Json("true"));

        Assert.True(result.Applied, result.Message);
    }

    // ── FormLink column: malformed / wrongly-shaped value ──────────────────────

    [Fact]
    public void RaceFormLinkColumn_MalformedString_IsRefusedAtTheEditFieldDoor()
    {
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "Race", Json("\"not-a-formkey\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidFormLink, result.Refusal);
    }

    [Fact]
    public void VoiceFormLinkColumn_NonStringJsonValue_IsRefusedAndWritesNothing()
    {
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "Voice", Json("42"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("Voice", result.Message, StringComparison.Ordinal);
    }

    // ── An OMOD carrying one property, for the sub-field-decline slice below ──

    [Fact]
    public void OmodPropertiesArray_DeclinedWidenedLeafValue_RefusesTheWholeArrayWrite()
    {
        using var omod = new OmodFixture();
        var before = omod.Body();

        var result = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "Properties",
            Json("""[{"Property":"BodyPart","Step":1.0,"MutagenObjectType":"ObjectModIntProperty<Armor+Property>","Value":"not-a-number","Value2":"7","FunctionType":"Set"}]"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("Properties", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, omod.Body());
    }

    // The sibling-merge "column exists on the schema, not on this instance" shape, which
    // TrackedModFixture's NPC has no equivalent of. GlobalShort rather than GlobalBool: Mutagen's
    // GlobalBool writes FLTV as one byte and reads back expecting four.
    private sealed class GlobFixture : IDisposable
    {
        private const string PluginName = "Glob532.esp";
        private const string Origin = "Glob532Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-glob-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-glob-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey GlobalShort { get; }
        public FormKey GlobalFloat { get; }

        public GlobFixture()
        {
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            var shortGlob = new Mutagen.Bethesda.Fallout4.GlobalShort(mod.GetNextFormKey("GlobShort532"), Fallout4Release.Fallout4)
            {
                EditorID = "GlobShort532",
                Data = 5,
            };
            var floatGlob = new Mutagen.Bethesda.Fallout4.GlobalFloat(mod.GetNextFormKey("GlobFloat532"), Fallout4Release.Fallout4)
            {
                EditorID = "GlobFloat532",
                Data = 1.25f,
            };
            mod.Globals.Add(shortGlob);
            mod.Globals.Add(floatGlob);
            mod.WriteToBinary(pluginPath);
            GlobalShort = shortGlob.FormKey;
            GlobalFloat = floatGlob.FormKey;

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)], GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string Body() => _mirror.Index!.At(RecordRef.Effective).GetDocument(GlobalShort.ToString(), Plugin)!.Body!;

        public void Dispose()
        {
            _mirror.Dispose();
            TryDelete(_modFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }

    private sealed class OmodFixture : IDisposable
    {
        private const string PluginName = "Omod532.esp";
        private const string Origin = "Omod532Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-omod532-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-omod532-game-").FullName;
        private readonly LoadOrderMirror _mirror;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey ArmorMod { get; }

        public OmodFixture()
        {
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod532"), Fallout4Release.Fallout4)
            {
                EditorID = "ArmorMod532",
            };
            armor.Properties.Add(new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f });
            mod.ObjectModifications.Add(armor);
            mod.WriteToBinary(pluginPath);
            ArmorMod = armor.FormKey;

            _mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)_mirror).Reconcile(
                _gameDirectory, [new LoadOrderEntry(PluginName, pluginPath, Origin, Slot: 0, Enabled: true, Winning: true)], GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_mirror.LoadOrder!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string Body() => _mirror.Index!.At(RecordRef.Effective).GetDocument(ArmorMod.ToString(), Plugin)!.Body!;

        public void Dispose()
        {
            _mirror.Dispose();
            TryDelete(_modFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
