using System.Globalization;
using System.Text;
using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

public sealed class RecordEditServiceCreateRecordTests
{
    private static ProjectingEditService ServiceFor(ILoadOrderMirror mirror) =>
        ProjectingEditService.Over(mirror);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_OnANeverCommittedRecord_ActuallyLandsInTheIndex()
    {
        using var mod = TrackedModFixture.Tracked();
        var service = ServiceFor(mod.Mirror);
        var created = service.CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");
        Assert.True(created.Applied, created.Message);

        var result = service.Set(mod.Plugin, created.NewFormKey!, "EditorID", Json("\"RenamedNpc\""));

        Assert.True(result.Applied, result.Message);
        var doc = mod.Mirror.Projected().GetDocument(created.NewFormKey!, mod.Plugin)!;
        Assert.Equal("RenamedNpc", doc.EditorId);
        Assert.Contains("RenamedNpc", doc.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateRecord_AllocatesAFormKey_WritesAMinimalSourceFile_RecordBecomesReadable()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        Assert.EndsWith(":" + TrackedModFixture.PluginName, result.NewFormKey, StringComparison.Ordinal);

        var sourceFile = Path.Combine(mod.ModFolder, mod.RelativeSourcePath(
            Mutagen.Bethesda.Plugins.FormKey.Factory(result.NewFormKey!), "npc_", "BrandNewNpc"));
        Assert.True(File.Exists(sourceFile));

        var doc = mod.Mirror.Projected().GetDocument(result.NewFormKey!, mod.Plugin);
        Assert.NotNull(doc);
        Assert.Equal("BrandNewNpc", doc!.EditorId);
    }

    [Fact]
    public void CreateRecord_AfterAnEarlierSiblingWasDeleted_LandsContiguously_NoGapSurvivesToLandPast()
    {
        using var mod = TrackedModFixture.Tracked();
        var service = ServiceFor(mod.Mirror);

        var deleted = service.DeleteRecord(mod.Plugin, mod.Npc.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        var created = service.CreateRecord(mod.Plugin, "npc_", "AfterTheGap");
        Assert.True(created.Applied, created.Message);

        var npcsDir = Path.Combine(mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "Npcs");
        var names = Directory.GetFiles(npcsDir)
            .Select(Path.GetFileName)
            .Where(n => !string.Equals(n, "GroupRecordData.json", StringComparison.Ordinal))
            .Select(n => n!)
            .Order(StringComparer.Ordinal)
            .ToList();

        // Neither file is renamed by the other's arrival or departure, and the create did not renumber
        // past a gap, because there are no numbers in these names to leave a gap in.
        Assert.Equal(2, names.Count);
        Assert.Contains(names, n => n.StartsWith("UntouchedNpc", StringComparison.Ordinal));
        Assert.Contains(names, n => n.StartsWith("AfterTheGap", StringComparison.Ordinal));
    }

    [Fact]
    public void CreateRecord_IsAbsentAtHead_UntilCommittedAndCompiled()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");

        Assert.Null(mod.Mirror.Projected(RecordRef.Head).GetDocument(result.NewFormKey!, mod.Plugin));
    }

    [Fact]
    public void CreateRecord_AllocatesConsecutiveFormIds_AcrossEffectiveAndHeadHoldings()
    {
        using var mod = TrackedModFixture.Tracked();
        mod.Mirror.Settle();
        var index = mod.Mirror.Index!;

        // A native record that exists only at Head — committed once, then deleted in the working
        // tree — which is the ingest-side seed for exactly that state. It is the shape an allocator
        // scanning only Effective would miss.
        const string headOnlyFormKey = "F00000:Fixture.esp";
        index.SeedCommittedOnly(mod.Plugin, [(headOnlyFormKey, "npc_", NpcBody(headOnlyFormKey, "HeadOnlySeed"))]);
        Assert.Null(index.At(RecordRef.Effective).GetDocument(headOnlyFormKey, mod.Plugin));
        Assert.NotNull(index.At(RecordRef.Head).GetDocument(headOnlyFormKey, mod.Plugin));

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "AllocatedAfter");

        Assert.True(result.Applied, result.Message);
        Assert.True(LocalId(result.NewFormKey!) > LocalId(headOnlyFormKey),
            $"expected an ID above {headOnlyFormKey}, got {result.NewFormKey} — the allocator must " +
            "consult Head, not just Effective.");
    }

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':')], NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    private static string NpcBody(string formKey, string editorId)
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var npc = new Npc(FormKey.Factory(formKey), Fallout4Release.Fallout4) { EditorID = editorId };
        var bytes = codec.SerializeToBytesAsync(npc, GameRelease.Fallout4).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(bytes);
    }

    [Fact]
    public void CreateRecord_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = TrackedModFixture.Untracked();

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateRecord_Refuses_WhileAnExternalChangeQuestionIsUnanswered()
    {
        using var mod = TrackedModFixture.Tracked();
        ExternalChangeDeferral.Set(mod.ModFolder, TrackedModFixture.PluginName, "unanswered");

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
    }

    [Fact]
    public void CreateRecord_Refuses_ForAnUnknownRecordType()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "not-a-real-type", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordTypeNotFound, result.Refusal);
    }

    [Fact]
    public void CreateRecord_Refuses_ForTheHeaderPseudoType()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "header", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordTypeNotFound, result.Refusal);
    }

    [Fact]
    public void CreateRecord_WithARequestedFormKey_Refuses_WhenItBelongsToADifferentPlugin()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "New", "900000:SomeOtherPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
    }

    [Fact]
    public void CreateRecord_WithARequestedFormKey_Refuses_WhenItCollides()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "New", mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
    }

    // The auto-allocator's own exhaustion (every local ID up to 0xFFFFFF taken)
    // must be a typed refusal, not an InvalidOperationException an endpoint's generic load order-missing
    // catch would misreport as "no usable load order".
    [Fact]
    public void CreateRecord_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = TrackedModFixture.Tracked();
        var service = ServiceFor(mod.Mirror);
        var seeded = service.CreateRecord(mod.Plugin, "npc_", "AtTheTop", "FFFFFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = service.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
        // This plugin is not light at all, so un-flagging ESL is not a way out of a full 0xFFFFFF native
        // space and the marker must never claim it is.
        Assert.False(result.EslContradiction);
    }

    // An ESL-flagged plugin's local FormID range is 12 bits: the game engine cannot address a higher
    // local ID from a light plugin's slot, so the allocator must refuse rather than continue.
    [Fact]
    public void CreateRecord_OnALightEspPlugin_Refuses_WhenTheEslRangeIsExhausted()
    {
        using var mod = TrackedModFixture.TrackedLight();
        var service = ServiceFor(mod.Mirror);
        var seeded = service.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap", "000FFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = service.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    // The same exhaustion, but light-ness is the removable header flag and native space above 0xFFF is
    // free, so the frontend can offer remove-the-flag-and-retry instead of a dead end.
    [Fact]
    public void CreateRecord_OnALightEspPlugin_WhenEslRangeExhausted_MarksEslContradiction()
    {
        using var mod = TrackedModFixture.TrackedLight();
        var service = ServiceFor(mod.Mirror);
        var seeded = service.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap", "000FFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = service.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.True(result.EslContradiction);
    }

    [Fact]
    public void CreateRecord_OnALightEspPlugin_AllocatesUpToTheEslCap()
    {
        using var mod = TrackedModFixture.TrackedLight();
        var service = ServiceFor(mod.Mirror);
        var seeded = service.CreateRecord(mod.Plugin, "npc_", "OneBelowTheEslCap", "000FFE:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = service.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap");

        Assert.True(result.Applied, result.Message);
        Assert.Equal("000FFF:Fixture.esp", result.NewFormKey);
    }

    // Same two directions, plain-.esl-extension shape (PluginFlagPredicates.IsLight's
    // extension-fallback branch) rather than the header-flagged-.esp shape above.
    [Fact]
    public void CreateRecord_OnAPlainEslPlugin_Refuses_WhenTheEslRangeIsExhausted()
    {
        using var mod = TrackedModFixture.TrackedLight("Fixture.esl");
        var service = ServiceFor(mod.Mirror);
        var seeded = service.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap", "000FFF:Fixture.esl");
        Assert.True(seeded.Applied, seeded.Message);

        var result = service.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    [Fact]
    public void CreateRecord_OnAPlainEslPlugin_AllocatesUpToTheEslCap()
    {
        using var mod = TrackedModFixture.TrackedLight("Fixture.esl");
        var service = ServiceFor(mod.Mirror);
        var seeded = service.CreateRecord(mod.Plugin, "npc_", "OneBelowTheEslCap", "000FFE:Fixture.esl");
        Assert.True(seeded.Applied, seeded.Message);

        var result = service.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap");

        Assert.True(result.Applied, result.Message);
        Assert.Equal("000FFF:Fixture.esl", result.NewFormKey);
    }

    // The typed-FormID path must refuse the same range a light plugin's auto-allocator does. The
    // record would exist in ordinary FormKey space, so this is its own refusal, not
    // FormKeySpaceExhausted.
    [Fact]
    public void CreateRecord_TypedTarget_OnALightPlugin_Refuses_AboveTheEslCap()
    {
        using var mod = TrackedModFixture.TrackedLight();

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "New", "001000:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LightPluginFormIdOutOfRange, result.Refusal);
    }

    [Fact]
    public void CreateRecord_TypedTarget_OnAnUnflaggedPlugin_AtTheSameId_Succeeds()
    {
        using var mod = TrackedModFixture.Tracked();
        const string requested = "001000:Fixture.esp";

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "New", requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }

    [Fact]
    public void CreateRecord_WithAFreeRequestedFormKey_UsesItExactly()
    {
        using var mod = TrackedModFixture.Tracked();
        const string requested = "900000:Fixture.esp";

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "New", requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }

    // _filter is a one-shot snapshot of whatever matched when SetFilter ran, and a brand-new row was
    // never evaluated against that SQL, so it stays hidden until the create path re-materializes it.
    [Fact]
    public void CreateRecord_MakesTheNewRecordAppearInAnActiveFilteredListing()
    {
        using var mod = TrackedModFixture.Tracked();
        mod.Mirror.SetFilter("SELECT form_key FROM npc_");
        var before = mod.Mirror.SettledReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 50, Offset: 0)).Total;

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");

        Assert.True(result.Applied, result.Message);
        var after = mod.Mirror.SettledReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 50, Offset: 0));
        Assert.Equal(before + 1, after.Total);
        Assert.Contains(after.Items, i => i.FormKey == result.NewFormKey);
    }
}
