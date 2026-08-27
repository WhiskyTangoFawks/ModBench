using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #503: a complex field (CONTEXT.md — array or struct) is written as one atomic value, and a payload
/// shaped like a single <i>element</i> of one is refused rather than silently dropped.
///
/// <para>The defect these pin: <c>SchemaReflector</c>'s list and struct appliers both returned without
/// writing when the JSON was not array-/object-shaped, and <c>RecordFieldWriter.TryApply</c> reported
/// <c>Applied</c> regardless — so the webview's per-element commit (which sent the bare leaf value
/// under the array's own field name) reported success while the source document stayed byte-identical.
/// The write half is fixed in the webview (it reconstructs the whole value before committing, the same
/// thing the array arity ops always did); this file pins the backend half of the contract — the whole
/// value lands, and anything element-shaped is a refusal a user can see.</para>
/// </summary>
public sealed class ComplexFieldElementEditTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string NpcBody() => _mod.Sessions.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;

    // ── per-element payloads are refused, not silently dropped ────────────────

    /// <summary>
    /// A plain FormLink array (NPC <c>keywords</c>), given the bare value of one element. The FormKey
    /// used is a genuinely valid target for this field, so nothing but the payload's <i>shape</i> can
    /// be what refuses it.
    /// </summary>
    [Fact]
    public void KeywordsArray_PerElementPayload_IsRefusedAndWritesNothing()
    {
        var seed = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords", Json($"[\"{_mod.Keyword}\"]"));
        Assert.True(seed.Applied, seed.Message);
        var before = NpcBody();

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords", Json($"\"{_mod.Keyword}\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("keywords", result.Message, StringComparison.Ordinal);
        Assert.Contains("array", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(before, NpcBody());
    }

    /// <summary>A plain struct (NPC <c>weight</c>), given the bare value of one member.</summary>
    [Fact]
    public void WeightStruct_PerMemberPayload_IsRefusedAndWritesNothing()
    {
        var before = NpcBody();

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "weight", Json("0.5"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("weight", result.Message, StringComparison.Ordinal);
        Assert.Contains("object", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(before, NpcBody());
    }

    /// <summary>
    /// A struct-element array (OMOD <c>properties</c>), given the bare value of one element's own
    /// sub-field — the shape #503 was reported against, and the one two levels of reconstruction away
    /// from the field's whole value.
    /// </summary>
    [Fact]
    public void OmodPropertiesArray_PerSubFieldPayload_IsRefusedAndWritesNothing()
    {
        using var omod = new OmodFixture();
        var before = omod.Body();

        var result = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties", Json("99"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("properties", result.Message, StringComparison.Ordinal);
        Assert.Contains("array", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(before, omod.Body());
    }

    // ── the whole-value write the webview now sends does land ─────────────────

    /// <summary>
    /// The reconstructed payload an element edit produces once the webview has done its job: the whole
    /// array, with one element different. This is the same write the sanctioned array arity ops already
    /// performed, so byte fidelity is unchanged by #503 — what changed is only that a value edit now
    /// sends this shape too.
    /// </summary>
    [Fact]
    public void KeywordsArray_WholeArrayWrite_LandsInTheSourceDocument()
    {
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords", Json($"[\"{_mod.Keyword}\"]"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains(_mod.Keyword.ToString(), NpcBody(), StringComparison.Ordinal);
    }

    [Fact]
    public void WeightStruct_WholeObjectWrite_LandsInTheSourceDocument()
    {
        var result = Service().EditField(
            _mod.Plugin, _mod.Npc.ToString(), "weight", Json("""{"thin":0.5,"fat":0.25,"muscular":0.75}"""));

        Assert.True(result.Applied, result.Message);
        var body = NpcBody();
        Assert.Contains("0.5", body, StringComparison.Ordinal);
        Assert.Contains("0.25", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// The same reconstruction one level deeper: a struct-element array (NPC <c>factions</c>, holding
    /// <c>RankPlacement</c>), where what the user edited is one element's own <c>rank</c> sub-field and
    /// what reaches this method is the whole array carrying it.
    ///
    /// <para><b>Not OMOD <c>properties</c>, which #503 named</b> — that field's element type is the
    /// abstract <c>AObjectModProperty&lt;T&gt;</c>, and <c>SchemaReflector.BuildListElement</c> used to
    /// derive its element type from the list's generic argument and call <c>Activator.CreateInstance</c>
    /// on it directly, which threw <c>MissingMethodException</c> for any abstract element type. That was
    /// independent of #503 (the sanctioned array arity ops hit it too) and was filed separately as #531,
    /// now fixed a few tests below in this same file; this field is the same struct-element-array shape
    /// with a concrete element type, so it pinned the reconstruction contract without depending on that
    /// fix while #531 was still open.</para>
    /// </summary>
    [Fact]
    public void FactionsStructArray_WholeArrayWriteWithAChangedSubField_LandsInTheSourceDocument()
    {
        // A real, resolvable Faction to point at: an element's FormLink sub-field is validated like any
        // other (Dangling/Type-Mismatched are refused ahead of the write), so a null or invented one
        // would refuse for a reason that has nothing to do with what this test is about.
        var faction = Service().CreateRecord(_mod.Plugin, "fact", "FixtureFaction");
        Assert.True(faction.Applied, faction.Message);

        var seed = Service().EditField(
            _mod.Plugin, _mod.Npc.ToString(), "factions",
            Json($"[{{\"faction\":\"{faction.NewFormKey}\",\"rank\":1}}]"));
        Assert.True(seed.Applied, seed.Message);

        var result = Service().EditField(
            _mod.Plugin, _mod.Npc.ToString(), "factions",
            Json($"[{{\"faction\":\"{faction.NewFormKey}\",\"rank\":9}}]"));

        Assert.True(result.Applied, result.Message);
        Assert.Contains("\"Rank\": 9", NpcBody(), StringComparison.Ordinal);
    }

    // ── #531: write-side polymorphism — OMOD properties' element type is abstract ─────────────

    /// <summary>
    /// The refusal AC #531 asks for: an abstract list element (OMOD's <c>AObjectModProperty&lt;T&gt;</c>)
    /// whose payload carries no <c>value_type</c> discriminator can never be constructed — before this
    /// fix, <c>SchemaReflector.BuildListElement</c> threw <see cref="MissingMethodException"/> straight
    /// out of the write path (uncaught, not this refusal) for <i>any</i> write to this field, discriminator
    /// or not. This is otherwise a well-formed whole-array write (an array, one well-shaped element) — the
    /// only thing wrong with it is the missing discriminator, which is what the message must actually say
    /// rather than repeating the "send an array" text #503's own per-element-payload refusal above uses.
    /// Its own <see cref="RecordEditRefusal.ListElementTypeUnresolved"/> value, not
    /// <see cref="RecordEditRefusal.FieldValueShapeMismatch"/> — the value genuinely is array-shaped, so
    /// a caller branching on the enum (ADR-0026) needs a different discriminator to reach for a
    /// different fix, not the "send an array" text.
    /// </summary>
    [Fact]
    public void OmodPropertiesArray_MissingValueTypeDiscriminator_IsRefusedAndWritesNothing()
    {
        using var omod = new OmodFixture();
        var before = omod.Body();

        var result = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties",
            Json("""[{"property":"BodyPart","step":1.0,"value":"5","value2":"6","function_type":"Set"}]"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ListElementTypeUnresolved, result.Refusal);
        Assert.Contains("properties", result.Message, StringComparison.Ordinal);
        Assert.Contains("value_type", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, omod.Body());
    }

    /// <summary>
    /// The same refusal, but the discriminator is <i>present</i> and simply names something that isn't
    /// one of the seven leaves — distinct from the "missing entirely" case above, and worth its own test:
    /// <c>ResolveObjectModPropertyConcreteType</c> has two separate ways to answer null
    /// (<c>TryGetProperty</c> failing vs. <c>Array.Find</c> failing), and only the first was exercised
    /// above.
    /// </summary>
    [Fact]
    public void OmodPropertiesArray_UnrecognizedValueTypeDiscriminator_IsRefusedAndWritesNothing()
    {
        using var omod = new OmodFixture();
        var before = omod.Body();

        var result = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties",
            Json("""[{"property":"BodyPart","step":1.0,"value_type":"NotARealValueType","value":"5"}]"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ListElementTypeUnresolved, result.Refusal);
        Assert.Contains("properties", result.Message, StringComparison.Ordinal);
        Assert.Contains("value_type", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, omod.Body());
    }

    /// <summary>
    /// #531 AC1: a whole-array write carrying one <c>ObjectModIntProperty</c>-shaped element (own
    /// <c>value_type</c> discriminator plus its own <c>value</c>/<c>value2</c>/<c>function_type</c> data)
    /// lands, with the concrete type <i>and</i> the data preserved on re-read — not just the type: giving
    /// the discriminator a working resolution but leaving the leaf union fields <c>Apply: null</c> would
    /// construct the right type and then silently drop every value onto it, which is the latent bug this
    /// ticket also closes (see <c>ApplySubFields</c>).
    /// </summary>
    [Fact]
    public void OmodPropertiesArray_WholeArrayWriteWithIntProperty_LandsWithConcreteTypeAndValuePreserved()
    {
        using var omod = new OmodFixture();

        var result = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties",
            Json("""[{"property":"BodyPart","step":1.0,"value_type":"Int","value":"42","value2":"7","function_type":"Set"}]"""));

        Assert.True(result.Applied, result.Message);
        var body = omod.Body();
        Assert.Contains("ObjectModIntProperty", body, StringComparison.Ordinal);
        Assert.Contains("\"Value\": 42", body, StringComparison.Ordinal);
        Assert.Contains("\"Value2\": 7", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// #531 AC2: a second concrete subtype round-trips too, proving the choice is read from each
    /// element's own <c>value_type</c> rather than hardcoded to Int (the only leaf the fixture's binary
    /// seed itself ever carries).
    /// </summary>
    [Fact]
    public void OmodPropertiesArray_WholeArrayWriteWithFloatProperty_RoundTripsAsFloatNotHardcodedInt()
    {
        using var omod = new OmodFixture();

        var result = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties",
            Json("""[{"property":"Weight","step":2.0,"value_type":"Float","value":1.5,"value2":2.5,"function_type":"Set"}]"""));

        Assert.True(result.Applied, result.Message);
        var body = omod.Body();
        Assert.Contains("ObjectModFloatProperty", body, StringComparison.Ordinal);
        Assert.DoesNotContain("ObjectModIntProperty", body, StringComparison.Ordinal);
        Assert.Contains("\"Value\": 1.5", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// #531 AC3 (Move Up/Move Down): reordering two elements of <i>different</i> concrete leaf types is
    /// the one shape that would defeat a position-based "reuse the existing element's type by index"
    /// design — the element now at index 0 is Float-shaped data, not the Int that used to be there. Each
    /// element's own <c>value_type</c> is what has to drive this, not its position.
    /// </summary>
    [Fact]
    public void OmodPropertiesArray_WholeArrayWriteReordered_PreservesEachElementsOwnConcreteType()
    {
        using var omod = new OmodFixture();
        var seed = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties", Json("""
            [
                {"property":"BodyPart","step":1.0,"value_type":"Int","value":"5","value2":"6","function_type":"Set"},
                {"property":"Weight","step":2.0,"value_type":"Float","value":"1.5","value2":"2.5","function_type":"Set"}
            ]
            """));
        Assert.True(seed.Applied, seed.Message);

        // Move Up on the second element == the whole array resent with the same two elements swapped.
        var result = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties", Json("""
            [
                {"property":"Weight","step":2.0,"value_type":"Float","value":"1.5","value2":"2.5","function_type":"Set"},
                {"property":"BodyPart","step":1.0,"value_type":"Int","value":"5","value2":"6","function_type":"Set"}
            ]
            """));

        Assert.True(result.Applied, result.Message);
        var body = omod.Body();
        var floatIdx = body.IndexOf("ObjectModFloatProperty", StringComparison.Ordinal);
        var intIdx = body.IndexOf("ObjectModIntProperty", StringComparison.Ordinal);
        Assert.True(floatIdx >= 0, body);
        Assert.True(intIdx >= 0, body);
        Assert.True(floatIdx < intIdx, $"Float element should now precede Int in:\n{body}");
    }

    /// <summary>#531 AC3 (Add): growing the array by one brand-new element alongside the existing one.</summary>
    [Fact]
    public void OmodPropertiesArray_WholeArrayWriteAddingANewElement_LandsAlongsideTheExisting()
    {
        using var omod = new OmodFixture();

        var result = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties", Json("""
            [
                {"property":"BodyPart","step":1.0,"value_type":"Int","value":5,"value2":6,"function_type":"Set"},
                {"property":"Value","step":3.0,"value_type":"Bool","value":true,"function_type":"Set"}
            ]
            """));

        Assert.True(result.Applied, result.Message);
        var body = omod.Body();
        Assert.Contains("ObjectModIntProperty", body, StringComparison.Ordinal);
        Assert.Contains("ObjectModBoolProperty", body, StringComparison.Ordinal);
    }

    /// <summary>
    /// #531 AC3 (Remove) and the data-loss regression guard for the latent <c>ApplySubFields</c> bug:
    /// removing the second element must not reset the surviving first element's own <c>Value</c>/
    /// <c>Value2</c> back to defaults — which is exactly what would happen if the leaf union fields kept
    /// <c>Apply: null</c> while element construction itself got fixed.
    /// </summary>
    [Fact]
    public void OmodPropertiesArray_RemoveShapedWholeArrayWrite_PreservesSurvivorsValue()
    {
        using var omod = new OmodFixture();
        var seed = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties", Json("""
            [
                {"property":"BodyPart","step":1.0,"value_type":"Int","value":"5","value2":"6","function_type":"Set"},
                {"property":"Weight","step":2.0,"value_type":"Float","value":"1.5","value2":"2.5","function_type":"Set"}
            ]
            """));
        Assert.True(seed.Applied, seed.Message);

        // Remove on the second element == the whole array resent holding only the survivor, verbatim.
        var result = omod.Service().EditField(omod.Plugin, omod.ArmorMod.ToString(), "properties",
            Json("""[{"property":"BodyPart","step":1.0,"value_type":"Int","value":"5","value2":"6","function_type":"Set"}]"""));

        Assert.True(result.Applied, result.Message);
        var body = omod.Body();
        Assert.Contains("\"Value\": 5", body, StringComparison.Ordinal);
        Assert.Contains("\"Value2\": 6", body, StringComparison.Ordinal);
        Assert.DoesNotContain("ObjectModFloatProperty", body, StringComparison.Ordinal);
    }

    // ── #532: a declined member fails the whole struct/array write, not just that member ──────

    /// <summary>
    /// #532 AC4: <c>weight</c> is an ordinary (non-abstract-element) struct, so every one of its
    /// sub-fields is reflected directly off <c>NpcWeight</c> — there is no leaf-union "doesn't apply
    /// to this concrete type" case here, only "the value itself couldn't be converted"
    /// (<c>thin</c>'s own float converter throwing on a non-numeric string). One bad member inside an
    /// otherwise well-shaped object must refuse the <i>whole</i> write, not silently apply the two
    /// good members and drop the bad one — the struct is one atomic value (CONTEXT.md), the same
    /// reason a per-member payload is refused above.
    /// </summary>
    [Fact]
    public void WeightStruct_OneMemberValueDeclined_RefusesTheWholeStructWrite()
    {
        var before = NpcBody();

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "weight",
            Json("""{"thin":"not-a-number","fat":0.5,"muscular":0.3}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldValueShapeMismatch, result.Refusal);
        Assert.Contains("weight", result.Message, StringComparison.Ordinal);
        Assert.Equal(before, NpcBody());
    }

    /// <summary>
    /// An OMOD carrying one <c>ObjectModIntProperty</c> — the struct-element array #503 was reported
    /// against, which <see cref="TrackedModFixture"/>'s three-record NPC shape has no equivalent of.
    /// Same posture as that fixture: a real mod folder, a real tracked session, no mocks.
    /// </summary>
    private sealed class OmodFixture : IDisposable
    {
        private const string PluginName = "Omod503.esp";
        private const string Origin = "Omod503Mod";

        private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-omod-mod-").FullName;
        private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-omod-game-").FullName;
        private readonly SessionManager _sessions;

        public PluginKey Plugin { get; } = new(PluginName, Origin);
        public FormKey ArmorMod { get; }

        public OmodFixture()
        {
            var pluginPath = Path.Combine(_modFolder, PluginName);
            var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
            var armor = new ArmorModification(mod.GetNextFormKey("ArmorMod503"), Fallout4Release.Fallout4)
            {
                EditorID = "ArmorMod503",
            };
            armor.Properties.Add(new ObjectModIntProperty<Armor.Property> { Property = Armor.Property.BodyPart, Step = 1f });
            mod.ObjectModifications.Add(armor);
            mod.WriteToBinary(pluginPath);
            ArmorMod = armor.FormKey;

            _sessions = new SessionManager(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ISessionManager)_sessions).LoadExplicit(
                _gameDirectory, [new ExplicitPluginInput(PluginName, pluginPath, Origin, true)], GameRelease.Fallout4);
            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(_sessions.Session!, Origin, SourcePreset.Edits)
                .GetAwaiter().GetResult();
        }

        public RecordEditService Service() =>
            new(_sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        public string Body() => _sessions.Index!.GetDocument(ArmorMod.ToString(), Plugin)!.Body!;

        public void Dispose()
        {
            _sessions.Dispose();
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
