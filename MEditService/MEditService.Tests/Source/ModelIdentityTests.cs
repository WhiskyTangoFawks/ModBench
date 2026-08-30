using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;

namespace MEditService.Tests.Source;

/// <summary>
/// #513, ADR-0042 decision 2's 2026-08 amendment: <see cref="ModelIdentity"/> is the shared,
/// standalone seam both <see cref="TrackService"/>'s gate and the test suite's own Compile
/// assertions (<c>StaleNextObjectIdRoundTripGateTests</c>) call into — tested directly here, not only
/// through <c>TrackService</c>, so a regression in the mask reflection or the exclusion list fails at
/// its own boundary.
/// </summary>
public sealed class ModelIdentityTests
{
    private static string FixturePath(string fileName) => Path.Combine(AppContext.BaseDirectory, "TestData", fileName);

    /// <summary>
    /// The concrete real-world case this whole ticket exists for: a real plugin
    /// (<c>RecruitSierra.esl</c>, #513's own survey — 114 overrides, zero self-authored) whose bytes
    /// change on a Mutagen rewrite (zlib re-deflate/negative-zero/subrecord-order, per the survey) but
    /// whose content does not. <b>Named rival</b>: the byte-identity check this gate is replacing
    /// would refuse this file outright (confirmed separately — this exact fixture is one of the two
    /// #506/#511 fixtures a byte-identity gate cannot pass); this test proves the seam that replaces
    /// it accepts the same file on model content alone.
    /// </summary>
    [Fact]
    public async Task FindFirst_OfARealPluginThatOnlyChangesBytesOnRewrite_ReturnsNull()
    {
        var (original, recompiled, originalBytes, rewrittenBytes) = await ParseWriteAndReparse("RecruitSierra.esl");

        // The rival, applied and observed: this fixture's own rewrite really does change its bytes —
        // otherwise this test would pass vacuously regardless of which verdict ModelIdentity computes.
        Assert.False(originalBytes.AsSpan().SequenceEqual(rewrittenBytes),
            "RecruitSierra.esl's rewrite no longer changes bytes — this test no longer exercises #513's own case.");

        var divergence = ModelIdentity.FindFirst(original, recompiled);

        Assert.Null(divergence);
    }

    /// <summary>
    /// Names the exact field the mask disagrees on — not just the record — for a genuine content
    /// difference. <c>HeightMin</c> is a plain <c>float</c> NPC_ subrecord field, chosen because it
    /// round-trips through a real binary write/reparse unmolested, so any observed divergence is the
    /// forged mutation, not an encoding artifact — the shape of #513's own "forge a deserializer that
    /// mutates a float" acceptance criterion.
    /// </summary>
    [Fact]
    public void FindFirst_WhenAFieldGenuinelyDiffers_NamesTheRecordAndTheField()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("OriginalNpc");
        npc.HeightMin = 1.5f;

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledNpc = new Npc(npc.FormKey, Fallout4Release.Fallout4) { EditorID = "OriginalNpc", HeightMin = 2.5f };
        recompiled.Npcs.Add(recompiledNpc);

        var divergence = ModelIdentity.FindFirst(mod, recompiled);

        Assert.NotNull(divergence);
        Assert.Equal("Npc", divergence!.RecordType);
        Assert.Equal(npc.FormKey, divergence.FormKey);
        Assert.Contains("HeightMin", divergence.Description);
    }

    /// <summary>
    /// ADR-0042 decision 2's one documented exclusion: a Cell whose <b>only</b> mask failures are
    /// GRUP-header-derived fields must still be accepted. <c>Timestamp</c>/<c>UnknownGroupData</c> are
    /// plain public properties on the generated <c>Cell</c> type (confirmed by reading
    /// <c>Cell_Generated.cs</c>: populated from the enclosing GRUP header at parse time, never from
    /// the cell's own subrecord stream), so this is forged directly through the object API — no real
    /// fixture needed to prove the exclusion list is applied inside the shared checker itself.
    /// </summary>
    [Fact]
    public void FindFirst_WhenOnlyGroupHeaderDerivedFieldsDiffer_ReturnsNull()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "TestCell", Timestamp = 1, UnknownGroupData = 2 };
        AddInteriorCell(mod, cell);

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledCell = new Cell(cell.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "TestCell",
            Timestamp = 99,
            UnknownGroupData = 100,
        };
        AddInteriorCell(recompiled, recompiledCell);

        var divergence = ModelIdentity.FindFirst(mod, recompiled);

        Assert.Null(divergence);
    }

    /// <summary>
    /// #513 finding, caught by the Slice F survey smoke test against real LitR data (not anticipated
    /// at plan time): a <c>Worldspace</c>'s own <c>TopCell</c> is a genuine embedded <c>Cell</c>, and
    /// Mutagen's generated mask for it nests a full <c>Cell.Mask&lt;bool&gt;</c> underneath
    /// <c>Worldspace.Mask&lt;bool&gt;.TopCell</c>. A <c>TopCell.Timestamp</c> divergence must still be
    /// excluded — it is exactly the same GRUP-header-derived field the direct-Cell test above already
    /// covers, just reached through a container. A naive implementation that always attributes a
    /// failing field to the <i>outer</i> enumerated record (<c>"Worldspace"</c>) rather than the field's
    /// own declaring type (<c>"Cell"</c>) would miss this exclusion and refuse.
    /// </summary>
    [Fact]
    public void FindFirst_WhenOnlyTheEmbeddedTopCellsGroupHeaderDerivedFieldsDiffer_ReturnsNull()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var ws = mod.Worldspaces.AddNew("TestWs");
        ws.TopCell = new Cell(mod) { Timestamp = 1, UnknownGroupData = 2 };

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledWs = new Worldspace(ws.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "TestWs",
            TopCell = new Cell(ws.TopCell!.FormKey, Fallout4Release.Fallout4) { Timestamp = 99, UnknownGroupData = 100 },
        };
        recompiled.Worldspaces.Add(recompiledWs);

        var divergence = ModelIdentity.FindFirst(mod, recompiled);

        Assert.Null(divergence);
    }

    /// <summary>
    /// #513 finding, caught the same way as the TopCell test above — this time against the LitR
    /// corpus itself (Slice F's own survey smoke test): a real plugin's <c>Worldspace.SubCells</c> is
    /// an <i>indexed list</i> of embedded <c>WorldspaceBlock</c>s, not a single nested record, and each
    /// block's own <c>LastModified</c>/<c>Unknown</c> are exactly the same class of GRUP-header field
    /// as <c>Cell.Timestamp</c>, one list level deeper. A block whose only divergence is that pair must
    /// still be excluded — proves <c>CollectFailingFields</c>'s indexed-list recursion, not just its
    /// single-nested-record one.
    /// </summary>
    [Fact]
    public void FindFirst_WhenOnlyASubCellsBlocksGroupHeaderDerivedFieldsDiffer_ReturnsNull()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var ws = mod.Worldspaces.AddNew("TestWs");
        ws.SubCells.Add(new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0, LastModified = 1, Unknown = 2 });

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledWs = new Worldspace(ws.FormKey, Fallout4Release.Fallout4) { EditorID = "TestWs" };
        recompiledWs.SubCells.Add(new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0, LastModified = 99, Unknown = 100 });
        recompiled.Worldspaces.Add(recompiledWs);

        var divergence = ModelIdentity.FindFirst(mod, recompiled);

        Assert.Null(divergence);
    }

    /// <summary>#568: the header counterpart to <see cref="FindFirst"/>'s per-record check. Every
    /// <see cref="ModelIdentity.OpaqueHeaderFields"/> member set to a distinguishable, matching value
    /// on both sides — the accept case a real Track that only recompiles (never edits) a plugin's
    /// header must hit.</summary>
    [Fact]
    public void FindFirstHeaderFieldDivergence_WithMatchingOpaqueFields_ReturnsNull()
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        SetOpaqueHeaderFields(original);

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        SetOpaqueHeaderFields(recompiled);

        var field = ModelIdentity.FindFirstHeaderFieldDivergence(original.ModHeader, recompiled.ModHeader);

        Assert.Null(field);
    }

    /// <summary>#568's own live gap, closed: a genuine content corruption on an allow-listed opaque
    /// field is named. Mirrors the real defect this ticket exists for — INTV surviving with the wrong
    /// bytes, not dropped outright (a drop is already caught upstream by
    /// <see cref="PluginBinaryWalk.FindFirstSubrecordLoss"/>).</summary>
    [Fact]
    public void FindFirstHeaderFieldDivergence_WhenAnAllowListedFieldDiffers_NamesTheField()
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        original.ModHeader.INTV = new byte[] { 1, 0, 0, 0 };

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        recompiled.ModHeader.INTV = new byte[] { 99, 0, 0, 0 };

        var field = ModelIdentity.FindFirstHeaderFieldDivergence(original.ModHeader, recompiled.ModHeader);

        Assert.Equal("INTV", field);
    }

    /// <summary>The allow-list's own boundary, proven rather than merely asserted: <c>Flags</c> is a
    /// genuine mask failure here (Localized set on only one side) yet is not reported —
    /// <see cref="ModelIdentity.OpaqueHeaderFields"/>' own doc comment's claim that <c>Flags</c> is a
    /// legitimate, write-time-derived divergence path stays enforced by this test, not just stated.</summary>
    [Fact]
    public void FindFirstHeaderFieldDivergence_WhenOnlyAnExcludedFieldDiffers_ReturnsNull()
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        original.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Localized;

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);

        var field = ModelIdentity.FindFirstHeaderFieldDivergence(original.ModHeader, recompiled.ModHeader);

        Assert.Null(field);
    }

    private static void SetOpaqueHeaderFields(Fallout4Mod mod)
    {
        mod.ModHeader.INTV = new byte[] { 1, 0, 0, 0 };
        mod.ModHeader.INCC = 42;
        mod.ModHeader.TypeOffsets = new byte[] { 9, 8, 7 };
        mod.ModHeader.Deleted = new byte[] { 1, 2, 3 };
        mod.ModHeader.Screenshot = new byte[] { 4, 5, 6 };
        mod.ModHeader.TransientTypes.Add(new TransientType { FormType = 7 });
    }

    private static void AddInteriorCell(Fallout4Mod mod, Cell cell)
    {
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(cell);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);
    }

    /// <summary>Mirrors <c>RoundTripSurvey</c>'s own write options — the shape
    /// <see cref="TrackService.VerifyRoundTrip"/> uses to reproduce a plugin's own bytes.</summary>
    private static async Task<(Fallout4Mod Original, Fallout4Mod Recompiled, byte[] OriginalBytes, byte[] RewrittenBytes)>
        ParseWriteAndReparse(string fileName)
    {
        var scratch = Directory.CreateTempSubdirectory("medit-modelidentity-").FullName;
        try
        {
            var original = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName(fileName), FixturePath(fileName)), Fallout4Release.Fallout4);

            var rewrittenPath = Path.Combine(scratch, fileName);
            await original.BeginWrite
                .ToPath(rewrittenPath)
                .WithLoadOrderFromHeaderMasters()
                .WithNoDataFolder()
                .NoNextFormIDProcessing()
                .WithRecordCount(RecordCountOption.NoCheck)
                .WriteAsync();

            var recompiled = Fallout4Mod.CreateFromBinary(
                new ModPath(ModKey.FromFileName(fileName), rewrittenPath), Fallout4Release.Fallout4);
            var originalBytes = await File.ReadAllBytesAsync(FixturePath(fileName));
            var rewrittenBytes = await File.ReadAllBytesAsync(rewrittenPath);
            return (original, recompiled, originalBytes, rewrittenBytes);
        }
        finally
        {
            Directory.Delete(scratch, recursive: true);
        }
    }
}
