using System.Globalization;
using System.Text;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #427: create-record, the entry point over <see cref="IRecordIndex.CreateWorkingTreeRecord"/>
/// (mechanism-tested at the index layer in <c>WorkingTreeCreationTests</c>). This suite is about the
/// entry point's own contract — FormKey allocation collision-safe across both refs, the source file
/// it writes, record-type validation, and the two refusals every gesture on this write path inherits.
/// </summary>
public sealed class RecordEditServiceCreateRecordTests
{
    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

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

        var doc = mod.Mirror.Index!.GetDocument(result.NewFormKey!, mod.Plugin);
        Assert.NotNull(doc);
        Assert.Equal("BrandNewNpc", doc!.EditorId);
    }

    /// <summary>
    /// #459 originally, superseded by #489: a delete used to leave a permanent gap (<c>[0],[1]</c> →
    /// delete <c>[0]</c> → <c>[1]</c> alone), and this test pinned that <see cref="RecordEditService.CreateRecord"/>
    /// landed past it (<c>[2]</c>) rather than colliding with it at the naive sibling <i>count</i>
    /// (<c>[1]</c>). #489 retired the gap itself: <see cref="RecordEditService.DeleteRecord"/> now
    /// renormalizes its own group folder to contiguous <c>[0..k]</c> as its own last file-system act,
    /// so by the time <c>CreateRecord</c> runs here there is no gap left to land past at all — the
    /// surviving sibling has already renumbered down to <c>[0]</c>, and count and max+1 coincide.
    /// </summary>
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
        var names = Directory.GetFiles(npcsDir).Select(Path.GetFileName).Order(StringComparer.Ordinal).ToList();

        // The delete's own renormalization already closed the gap — the surviving sibling now carries
        // [0], not the [1] it started at, and the new record appends at the true next contiguous slot,
        // [1], not [2].
        Assert.Equal(2, names.Count);
        Assert.Contains(names, n => n!.StartsWith("[0] UntouchedNpc", StringComparison.Ordinal));
        Assert.Contains(names, n => n!.StartsWith("[1] AfterTheGap", StringComparison.Ordinal));
    }

    [Fact]
    public void CreateRecord_IsAbsentAtHead_UntilCommittedAndCompiled()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");

        Assert.Null(mod.Mirror.Index!.At(RecordRef.Head).GetDocument(result.NewFormKey!, mod.Plugin));
    }

    [Fact]
    public void CreateRecord_AllocatesConsecutiveFormIds_AcrossEffectiveAndHeadHoldings()
    {
        using var mod = TrackedModFixture.Tracked();
        var index = mod.Mirror.Index!;

        // Seed a native record that exists ONLY at Head — created directly at the index layer with a
        // deliberately high local ID, "committed" via SetCommittedBaseline (this test's own stand-in
        // for the real git commit a compile would eventually make), then deleted in the working tree.
        // Gone at Effective, still answering at Head — exactly the shape a compiled-then-deleted
        // native record has, and the case an allocator that only scanned Effective would miss.
        const string headOnlyFormKey = "F00000:Fixture.esp";
        var seedBody = NpcBody(headOnlyFormKey, "HeadOnlySeed");
        index.CreateWorkingTreeRecord(mod.Plugin, headOnlyFormKey, "npc_", seedBody);
        index.SetCommittedBaseline(mod.Plugin, [(headOnlyFormKey, seedBody)]);
        index.ApplyWorkingTreeChanges(mod.Plugin, [(headOnlyFormKey, null)]);
        Assert.Null(index.GetDocument(headOnlyFormKey, mod.Plugin));
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

    // Review finding #1: the auto-allocator's own exhaustion (every local ID up to 0xFFFFFF taken)
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
    }

    // #501: an ESL-flagged plugin's local FormID range is 0x000-0xFFF (12 bits) — the game engine
    // cannot address a higher local ID from a light plugin's load-order slot, so the auto-allocator
    // must refuse there rather than continuing on into the full 0xFFFFFF native range.
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

    // #501: the typed-FormID path (xEdit's own "type a FormID" gesture) must refuse the same range a
    // light plugin's auto-allocator does — the record would exist in perfectly ordinary FormKey space,
    // so this is its own refusal (LightPluginFormIdOutOfRange), not FormKeySpaceExhausted.
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

    // #422: _filter is a one-shot snapshot of whatever matched when SetFilter ran — a brand-new row
    // was never evaluated against that SQL at all, so it stays hidden from a broad "every NPC" filter
    // until the create path re-materializes it.
    [Fact]
    public void CreateRecord_MakesTheNewRecordAppearInAnActiveFilteredListing()
    {
        using var mod = TrackedModFixture.Tracked();
        mod.Mirror.SetFilter("SELECT form_key FROM npc_");
        var before = mod.Mirror.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 50, Offset: 0)).Total;

        var result = ServiceFor(mod.Mirror).CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");

        Assert.True(result.Applied, result.Message);
        var after = mod.Mirror.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 50, Offset: 0));
        Assert.Equal(before + 1, after.Total);
        Assert.Contains(after.Items, i => i.FormKey == result.NewFormKey);
    }
}
