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

/// <summary>
/// The scalar half of the silent-success defect — the *complex* half (array/struct shape guards)
/// is <c>ComplexFieldElementEditTests</c>' job. What this file pins:
/// <c>SchemaReflector.MakeApplier</c> (missing property,
/// declined converter, JSON <c>null</c> into a non-nullable column) and
/// <c>FormLinkColumnApplier</c>/<c>ApplyFormLinkJson</c> (missing property, unparseable/wrongly-shaped
/// FormKey) both answered success unconditionally, no matter what they actually wrote.
///
/// <para><b>Two findings that reshape what's actually reachable here</b> (confirmed by reading, not
/// assumed): most malformed-FormKey-string writes are already refused before they ever reach
/// <c>ApplyFormLinkJson</c>, because <c>RecordEditService.ValidateFormLinks</c> →
/// <c>CheckErrorBuilder</c> walks every FormLink leaf (column, struct sub-field, array element) ahead
/// of <c>RecordFieldWriter.TryApply</c>, and its resolve is a raw string match — any string that
/// doesn't resolve, malformed or merely absent, already refuses as <c>InvalidFormLink</c>. What isn't
/// pre-empted is a JSON value that isn't even a string (e.g. a bare number) sent for a
/// <i>nullable</i> FormLink column: <c>CheckErrorBuilder</c> treats a non-string as "no reference",
/// which is allowed when the column is nullable, so it sails through to
/// <c>ApplyFormLinkJson</c>'s own <c>GetString()</c> call, which throws — previously caught and
/// silently discarded. Separately, "the converter declined the value" doesn't mean the converter
/// returned <c>null</c> today — none of them do; they throw (<c>InvalidOperationException</c> for the
/// wrong JSON token kind, <c>ArgumentException</c> for an unrecognised enum member,
/// <c>FormatException</c> for a bad bitmask string), so the pre-fix behaviour for most of these is an
/// uncaught exception out of <c>RecordEditService.EditField</c>, not a graceful "reported applied".
/// </para>
/// </summary>
public sealed class ScalarFieldApplierRefusalTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string NpcBody() => _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;

    // ── converter-declined scalar values ───────────────────────────────────────

    /// <summary>
    /// Pre-fix observed result: an uncaught <c>System.InvalidOperationException</c> ("The requested
    /// operation requires an element of type 'Number', but the target element has type 'String'.")
    /// propagating straight out of <c>EditField</c> — confirmed by running this test against
    /// unmodified <c>SchemaReflector.MakeApplier</c>, not assumed from reading. Not a graceful
    /// refusal and not a reported success either — a crash, more severe than a
    /// silent no-op.
    /// </summary>
    [Fact]
    public void HeightMaxFloatColumn_NonNumericString_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("\"tall\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("height_max", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    /// <summary>Breadth pin on the identical fix: a bitmask enum column's own converter
    /// (<c>ReadBitmaskLong</c>'s <c>long.Parse</c>) throws <c>FormatException</c> for a non-numeric
    /// string, same as the float case above, just a different converter and exception type.</summary>
    [Fact]
    public void FlagsBitmaskColumn_NonNumericString_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "flags", Json("\"NotANumber\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("flags", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    /// <summary>Second breadth pin: a plain (non-bitmask) enum column's <c>Enum.Parse</c> throws
    /// <c>ArgumentException</c> for a member name that doesn't exist — an unrecognised enum
    /// name.</summary>
    [Fact]
    public void AggressionEnumColumn_UnrecognisedMemberName_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "aggression", Json("\"NotARealAggressionLevel\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("aggression", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    /// <summary>Scalar direction: a well-formed value still lands and still reports applied —
    /// the positive control proving the refusals above are about the value, not about this field
    /// having gone read-only by accident.</summary>
    [Fact]
    public void HeightMaxFloatColumn_ValidValue_StillReportsApplied()
    {
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("0.75", NpcBody(), StringComparison.Ordinal);
    }

    // ── missing property on this record's own runtime type ────────────────────

    /// <summary>
    /// GLOB's <c>output_char</c> column is real, not hypothetical — declared only on
    /// <c>IGlobalFloatGetter</c> among the four GLOB subclasses (confirmed by the existing
    /// <c>GetSchemas_Glob_OutputCharColumn_ExclusiveToGlobalFloat_NullOnOtherSubclasses</c>), and
    /// reachable on a <c>GlobalShort</c> instance because the sibling-merge unions every
    /// subclass's own columns into one schema. Pre-fix observed result: <c>Applied = true</c>, the
    /// source document byte-identical — the cleanest silent no-op of the family
    /// (no exception involved).
    ///
    /// <para><c>GlobalShort</c>, not <c>GlobalBool</c> (the more obvious "doesn't have it" sibling):
    /// confirmed by a throwaway probe that Mutagen's own <c>GlobalBool</c> binary writer/reader
    /// round-trip is independently broken (writes its <c>FLTV</c> subrecord as 1 byte, read back
    /// expecting 4 — <c>Mutagen.Bethesda.Plugins.Exceptions.RecordException</c>), an unrelated
    /// defect and not something to route around by relaxing this test's own fixture fidelity.</para>
    /// </summary>
    [Fact]
    public void OutputCharColumn_OnGlobalShortInstance_IsRefusedAsFieldNotFound()
    {
        using var glob = new GlobFixture();
        var before = glob.Body();

        var result = glob.Service().EditField(glob.Plugin, glob.GlobalShort.ToString(), "output_char", Json("true"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Equal(before, glob.Body());
    }

    /// <summary>Positive control for the fixture/field itself: the same column, on the
    /// <c>GlobalFloat</c> instance that actually declares it, still applies.</summary>
    [Fact]
    public void OutputCharColumn_OnGlobalFloatInstance_StillReportsApplied()
    {
        using var glob = new GlobFixture();

        var result = glob.Service().EditField(glob.Plugin, glob.GlobalFloat.ToString(), "output_char", Json("true"));

        Assert.True(result.Applied, result.Message);
    }

    // ── FormLink column: malformed / wrongly-shaped value ──────────────────────

    /// <summary>
    /// Exercised at the public <c>EditField</c> door: <c>ValidateFormLinks</c>
    /// (<c>CheckErrorBuilder</c>'s raw string resolve) refuses any string that doesn't
    /// resolve, malformed or merely absent, as <c>InvalidFormLink</c> before
    /// <c>RecordFieldWriter.TryApply</c> — let alone <c>ApplyFormLinkJson</c> — is ever reached. Kept
    /// here as a documented pin (the same posture <c>TopLevelFormLinkColumnEditTests</c> takes for
    /// its already-green columns), not claimed as a red-to-green proof.
    /// </summary>
    [Fact]
    public void RaceFormLinkColumn_MalformedString_IsRefusedAtTheEditFieldDoor()
    {
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "race", Json("\"not-a-formkey\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidFormLink, result.Refusal);
    }

    /// <summary>
    /// The genuinely-reachable variant: <c>voice</c> is a <i>nullable</i> FormLink column
    /// (<c>GetSchemas_Npc_Voice_IsNullableFormLink</c>), so <c>CheckErrorBuilder</c>'s
    /// <c>ExtractString</c> returns <c>null</c> for a non-string JSON value (a bare number), which
    /// <c>CheckScalar</c> treats as "no reference" — allowed, since the column is nullable — and lets
    /// straight through <c>ValidateFormLinks</c>. Pre-fix observed result: <c>Applied = true</c>: the
    /// value silently failed to write (<c>ApplyFormLinkJson</c>'s own <c>val.GetString()</c> throws
    /// <c>InvalidOperationException</c> for a Number-kind element, caught by its blanket try/catch,
    /// logged at Trace, and swallowed) while the write path reported success regardless.
    /// </summary>
    [Fact]
    public void VoiceFormLinkColumn_NonStringJsonValue_IsRefusedAndWritesNothing()
    {
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "voice", Json("42"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("voice", result.Message, StringComparison.Ordinal);
    }

    // ── An OMOD carrying one property, for the sub-field-decline slice below ──

    /// <summary>
    /// A struct-element array (OMOD's <c>properties</c>) where one element's own widened
    /// leaf-union sub-field (<c>value</c>) is present on the concrete leaf but carries a value that
    /// leaf's own converter (<c>ConvertWidenedJson</c>) declines — distinct from
    /// <c>ComplexFieldElementEditTests</c>' plain-struct sibling test: this one exercises the
    /// sparse leaf-union path (<c>MakeWidenedApplier</c>/<c>ApplySubFields</c>), where a
    /// <i>different</i> reason for "property not found" (a leaf that simply lacks this member) must
    /// stay silent while this reason (present but unconvertible) must not.
    /// </summary>
    [Fact]
    public void OmodPropertiesArray_DeclinedWidenedLeafValue_RefusesTheWholeArrayWrite()
    {
        using var omod = new OmodFixture();
        var before = omod.Body();

        var result = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties",
            Json("""[{"property":"BodyPart","step":1.0,"value_type":"Int","value":"not-a-number","value2":"7","function_type":"Set"}]"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("properties", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, omod.Body());
    }

    /// <summary>An OMOD carrying one <c>GlobalFloat</c>/<c>GlobalShort</c> pair — the sibling-merge
    /// "column exists on the schema, not on this instance" shape, which
    /// <see cref="TrackedModFixture"/>'s NPC-only shape has no equivalent of.</summary>
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

    /// <summary>An OMOD carrying one <c>ObjectModIntProperty</c> — same shape
    /// <c>ComplexFieldElementEditTests.OmodFixture</c> uses, duplicated per this codebase's
    /// established self-contained-fixture-per-file convention
    /// (<c>GenericFieldWriteDispatchTests.ConditionOwnerFixture</c>'s own stated reasoning).</summary>
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
