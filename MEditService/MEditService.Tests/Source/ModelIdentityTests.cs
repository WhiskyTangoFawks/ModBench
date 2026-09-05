using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Source;

/// <summary>Tested directly, not only through <c>TrackService</c>, so a regression in the mask
/// reflection or the exclusion list fails at its own boundary (ADR-0042 decision 2).</summary>
public sealed class ModelIdentityTests
{
    private static string FixturePath(string fileName) => Path.Combine(AppContext.BaseDirectory, "TestData", fileName);

    [Fact]
    public async Task FindFirst_OfARealPluginThatOnlyChangesBytesOnRewrite_ReturnsNull()
    {
        var (original, recompiled, originalBytes, rewrittenBytes) = await ParseWriteAndReparse("RecruitSierra.esl");

        // The rival, applied and observed: this fixture's own rewrite really does change its bytes —
        // otherwise this test would pass vacuously regardless of which verdict ModelIdentity computes.
        Assert.False(originalBytes.AsSpan().SequenceEqual(rewrittenBytes),
            "RecruitSierra.esl's rewrite does not change bytes — this test does not exercise the byte-changing rewrite it depends on.");

        var divergence = ModelIdentity.FindFirst(original, recompiled);

        Assert.Null(divergence);
    }

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

    public static IEnumerable<object[]> AllowListedHeaderFieldCorruptions()
    {
        yield return new object[] { "TypeOffsets", Setter(h => h.TypeOffsets = new byte[] { 1, 2, 3 }), Setter(h => h.TypeOffsets = new byte[] { 9, 9, 9 }) };
        yield return new object[] { "Deleted", Setter(h => h.Deleted = new byte[] { 1, 2, 3 }), Setter(h => h.Deleted = new byte[] { 9, 9, 9 }) };
        yield return new object[] { "Screenshot", Setter(h => h.Screenshot = new byte[] { 1, 2, 3 }), Setter(h => h.Screenshot = new byte[] { 9, 9, 9 }) };
        yield return new object[] { "INTV", Setter(h => h.INTV = new byte[] { 1, 0, 0, 0 }), Setter(h => h.INTV = new byte[] { 99, 0, 0, 0 }) };
        yield return new object[] { "INCC", Setter(h => h.INCC = 1), Setter(h => h.INCC = 2) };
        yield return new object[] { "Author", Setter(h => h.Author = "Original"), Setter(h => h.Author = "Corrupted") };
        yield return new object[] { "Description", Setter(h => h.Description = "Original"), Setter(h => h.Description = "Corrupted") };

        static Action<Fallout4ModHeader> Setter(Action<Fallout4ModHeader> action) => action;
    }

    [Theory]
    [MemberData(nameof(AllowListedHeaderFieldCorruptions))]
    public void FindFirstHeaderFieldDivergence_ForEveryAllowListedField_NamesItWhenItAloneDiverges(
        string fieldName, Action<Fallout4ModHeader> setOriginal, Action<Fallout4ModHeader> setCorrupted)
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        setOriginal(original.ModHeader);

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        setCorrupted(recompiled.ModHeader);

        var field = ModelIdentity.FindFirstHeaderFieldDivergence(original.ModHeader, recompiled.ModHeader);

        Assert.Equal(fieldName, field);
    }

    [Fact]
    public void FindFirstHeaderFieldDivergence_WhenOnlyAnExcludedFieldDiffers_ReturnsNull()
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        original.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Localized;

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);

        var field = ModelIdentity.FindFirstHeaderFieldDivergence(original.ModHeader, recompiled.ModHeader);

        Assert.Null(field);
    }

    // ── The comparison door must not inherit the generated comparers' lies ──
    //
    // Mutagen's Equals and GetEqualsMask each miss real divergence and the pin stays 0.53.1, so the
    // verdict may never depend on them alone.

    [Fact]
    public void FindFirst_WhenOnlyAGenderedItemSubFieldDiffers_ReportsTheDivergence()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var armor = mod.Armors.AddNew("GenderedArmor");
        armor.WorldModel = new GenderedItem<ArmorModel?>(
            new ArmorModel { Model = new Model { File = "male.nif" } }, null);

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledArmor = new Armor(armor.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "GenderedArmor",
            WorldModel = new GenderedItem<ArmorModel?>(
                new ArmorModel { Model = new Model { File = "DIFFERENT.nif" } }, null),
        };
        recompiled.Armors.Add(recompiledArmor);

        // Which stage catches it, pinned: generated Equals lies about GenderedItem (upstream #685), but the
        // mask does see this sub-field. If this assertion starts failing, the mask regressed and the
        // decider below is what keeps the verdict honest.
        Assert.NotEmpty(ModelIdentity.FailingFields(armor, recompiledArmor));

        var divergence = ModelIdentity.FindFirst(mod, recompiled);

        Assert.NotNull(divergence);
        Assert.Equal(armor.FormKey, divergence!.FormKey);
    }

    [Fact]
    public void FindFirst_WhenOnlyAPackageDataIntValueDiffers_ReportsTheDivergence()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var package = mod.Packages.AddNew("IntPackage");
        package.Data.Add(0, new PackageDataInt { Name = "Count", Data = 1 });

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledPackage = new Package(package.FormKey, Fallout4Release.Fallout4) { EditorID = "IntPackage" };
        recompiledPackage.Data.Add(0, new PackageDataInt { Name = "Count", Data = 99 });
        recompiled.Packages.Add(recompiledPackage);

        // Which stage catches it, pinned: the mask misses this one, the polymorphic base-overload binding
        // never comparing PackageDataInt's derived-only Data, so the codec decider refuses it. A mask fix
        // flips this first assertion, not the verdict.
        Assert.Empty(ModelIdentity.FailingFields(package, recompiledPackage));

        var divergence = ModelIdentity.FindFirst(mod, recompiled);

        Assert.NotNull(divergence);
        Assert.Equal(package.FormKey, divergence!.FormKey);
    }

    // The dictionary tolerance's boundary: NpcMorph's elements are exactly {Key, Value} but Npc.Morphs
    // is an ordered list, so a reorder is a real content change and must be refused rather than
    // forgiven as dictionary enumeration order.
    [Fact]
    public void FindFirst_WhenAnOrderedKeyValueShapedListIsReordered_ReportsTheDivergence()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("MorphNpc");
        npc.Morphs.Add(new NpcMorph { Key = 1, Value = 0.25f });
        npc.Morphs.Add(new NpcMorph { Key = 2, Value = 0.75f });

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        var recompiledNpc = new Npc(npc.FormKey, Fallout4Release.Fallout4) { EditorID = "MorphNpc" };
        recompiledNpc.Morphs.Add(new NpcMorph { Key = 2, Value = 0.75f });
        recompiledNpc.Morphs.Add(new NpcMorph { Key = 1, Value = 0.25f });
        recompiled.Npcs.Add(recompiledNpc);

        Assert.NotNull(ModelIdentity.FindFirst(mod, recompiled));
    }

    [Fact]
    public void FindFirstHeaderFieldDivergence_WithATransientTypesItemCorruption_NamesTransientTypes()
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        original.ModHeader.TransientTypes.Add(new TransientType { FormType = 7 });

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        recompiled.ModHeader.TransientTypes.Add(new TransientType { FormType = 99 });

        var field = ModelIdentity.FindFirstHeaderFieldDivergence(original.ModHeader, recompiled.ModHeader);

        Assert.Equal("TransientTypes", field);
    }

    [Fact]
    public void FindFirstHeaderFieldDivergence_WithATransientTypesCountDivergence_NamesTransientTypes()
    {
        var original = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        original.ModHeader.TransientTypes.Add(new TransientType { FormType = 7 });

        var recompiled = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);

        // The underlying Mutagen quirk is unchanged — the mask still sees nothing — which is
        // exactly why the gate's own comparer exists.
        Assert.Empty(ModelIdentity.FailingFields(original.ModHeader, recompiled.ModHeader));

        var field = ModelIdentity.FindFirstHeaderFieldDivergence(original.ModHeader, recompiled.ModHeader);

        Assert.Equal("TransientTypes", field);
    }

    private static void SetOpaqueHeaderFields(Fallout4Mod mod)
    {
        mod.ModHeader.INTV = new byte[] { 1, 0, 0, 0 };
        mod.ModHeader.INCC = 42;
        mod.ModHeader.TypeOffsets = new byte[] { 9, 8, 7 };
        mod.ModHeader.Deleted = new byte[] { 1, 2, 3 };
        mod.ModHeader.Screenshot = new byte[] { 4, 5, 6 };
        mod.ModHeader.Author = "Some Author";
        mod.ModHeader.Description = "Some Description";
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

    [Fact]
    public async Task FindFirst_CodecDeciderCost_IsLoggedAndBounded()
    {
        var (original, recompiled, _, _) = await ParseWriteAndReparse("RecruitSierra.esl");
        // Warm the codec/serializer once so the measurement is the steady-state cost.
        Assert.Null(ModelIdentity.FindFirst(original, recompiled));

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        Assert.Null(ModelIdentity.FindFirst(original, recompiled));
        stopwatch.Stop();

        var recordCount = original.EnumerateMajorRecords().Count();
        _output.WriteLine(
            $"FindFirst over {recordCount} records: {stopwatch.ElapsedMilliseconds} ms " +
            $"({(double)stopwatch.ElapsedMilliseconds / recordCount:F2} ms/record, warm)");
        Assert.True(stopwatch.ElapsedMilliseconds < 30_000, $"took {stopwatch.ElapsedMilliseconds} ms");
    }

    private readonly Xunit.Abstractions.ITestOutputHelper _output;

    public ModelIdentityTests(Xunit.Abstractions.ITestOutputHelper output) => _output = output;

    internal static async Task<(Fallout4Mod Original, Fallout4Mod Recompiled, byte[] OriginalBytes, byte[] RewrittenBytes)>
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
