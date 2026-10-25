using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Installs;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;
using Noggog;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>Skipped, not passed, without MEDIT_REGEN_TESTDATA=1, so a run reports honestly rather than a
/// green no-op.</summary>
public sealed class RegenerateFactAttribute : FactAttribute
{
    public RegenerateFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("MEDIT_REGEN_TESTDATA") != "1")
            Skip = "A tool, not an assertion: run MEDIT_REGEN_TESTDATA=1 dotnet test --filter FullyQualifiedName~CutDownPluginGenerator "
                + "with Fallout 4 installed to regenerate TestData/mEditTestSubset.esm, then commit it.";
    }
}

/// <summary>Regenerates the committed cut-down plugin from a locally installed Fallout 4.</summary>
public sealed class CutDownPluginGenerator
{
    // Indexing reconstructs FormKeys from the header without Fallout4.esm present.
    private static readonly BinaryWriteParameters ListingFallout4EsmAsTheMasterOfTheOverridesKept = new()
    {
        MastersListContent = MastersListContentOption.Iterate,
    };

    private const int RecordsPerType = 4;
    private const int CellsPerSubBlock = 3;
    private const int RefsPerCell = 10;

    [RegenerateFact]
    public void RegenerateCutDownPlugin()
    {
        Assert.True(new GameLocator().TryGetDataDirectory(GameRelease.Fallout4, out var dataDir), "Fallout 4 is not installed.");
        var sourcePath = Path.Combine(dataDir.Path, "Fallout4.esm");
        Assert.True(File.Exists(sourcePath), $"Fallout4.esm not found at {sourcePath}");
        GiveMutagenTheLocalAppDataItsLanguageSourcesReadOnLinux();

        using var source = Fallout4Mod.CreateFromBinaryOverlay(
            new ModPath(ModKey.FromFileName("Fallout4.esm"), sourcePath), Fallout4Release.Fallout4,
            new BinaryReadParameters
            {
                StringsParam = new StringsReadParameters
                {
                    BsaFolderOverride = dataDir,
                    TargetLanguage = Language.English,
                },
            });

        var target = new Fallout4Mod(
            ModKey.FromFileName(RealDataPlugin.PluginFileName), Fallout4Release.Fallout4)
        {
            ModHeader = { Author = "mEdit", Description = "Generated cut-down test slice of Fallout4.esm — not for game use." },
        };

        CopyBreadth(source, target);
        CopyVmadRecords(source, target);
        CopyWorldspace(source, target);
        CopyInteriorCells(source, target);

        var outPath = Path.Combine(SourceTestDataDir(), RealDataPlugin.PluginFileName);
        Directory.CreateDirectory(Path.GetDirectoryName(outPath) ?? throw new InvalidOperationException($"Expected '{outPath}' to have a parent directory."));
        target.WriteToBinary(outPath, ListingFallout4EsmAsTheMasterOfTheOverridesKept);

        var size = new FileInfo(outPath).Length;
        Assert.True(size is > 0 and < 5 * 1024 * 1024, $"Unexpected cut-down plugin size: {size} bytes");
    }

    // Fallout4.esm is localized (strings packed in BA2s). DeepCopy enumerates every language
    // source; on Linux that path resolves a plugin-listings path that needs the (case-sensitive)
    // "LocalAppData" env var.
    private static void GiveMutagenTheLocalAppDataItsLanguageSourcesReadOnLinux()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LocalAppData")))
            Environment.SetEnvironmentVariable("LocalAppData", Path.GetTempPath());
    }

    // A spread of common major-record types so SchemaReflector's per-type extraction runs on real data.
    private static void CopyBreadth(IFallout4ModGetter src, Fallout4Mod dst)
    {
        foreach (var r in src.Keywords.Take(RecordsPerType)) dst.Keywords.Add(r.DeepCopy());
        foreach (var r in src.Factions.Take(RecordsPerType)) dst.Factions.Add(r.DeepCopy());
        foreach (var r in src.Races.Take(RecordsPerType)) dst.Races.Add(r.DeepCopy());
        foreach (var r in src.Weapons.Take(RecordsPerType)) dst.Weapons.Add(r.DeepCopy());
        foreach (var r in src.Armors.Take(RecordsPerType)) dst.Armors.Add(r.DeepCopy());
        foreach (var r in src.MiscItems.Take(RecordsPerType)) dst.MiscItems.Add(r.DeepCopy());
        foreach (var r in src.Globals.Take(RecordsPerType)) dst.Globals.Add(r.DeepCopy());
    }

    // Records with real VMAD scripts, so the VMAD indexer runs on authentic property shapes.
    private static void CopyVmadRecords(IFallout4ModGetter src, Fallout4Mod dst)
    {
        foreach (var n in src.Npcs.Where(x => x.VirtualMachineAdapter != null).Take(RecordsPerType))
            dst.Npcs.Add(n.DeepCopy());
        foreach (var q in src.Quests.Where(x => x.VirtualMachineAdapter != null).Take(RecordsPerType))
            dst.Quests.Add(q.DeepCopy());
        foreach (var a in src.Activators.Where(x => x.VirtualMachineAdapter != null).Take(RecordsPerType))
            dst.Activators.Add(a.DeepCopy());
    }

    private static void CopyWorldspace(IFallout4ModGetter src, Fallout4Mod dst)
    {
        var srcW = src.Worldspaces.FirstOrDefault();
        if (srcW is null) return;

        var w = dst.Worldspaces.AddNew();
        w.EditorID = srcW.EditorID;

        if (srcW.TopCell is { } tc)
            w.TopCell = TrimCell(tc.DeepCopy());

        if (srcW.SubCells.Count == 0) return;
        var srcBlock = srcW.SubCells[0];

        var block = new WorldspaceBlock { BlockNumberX = srcBlock.BlockNumberX, BlockNumberY = srcBlock.BlockNumberY };
        if (srcBlock.Items.Count > 0)
        {
            var srcSub = srcBlock.Items[0];
            var sub = new WorldspaceSubBlock { BlockNumberX = srcSub.BlockNumberX, BlockNumberY = srcSub.BlockNumberY };
            foreach (var c in srcSub.Items.Take(CellsPerSubBlock))
                sub.Items.Add(TrimCell(c.DeepCopy()));
            block.Items.Add(sub);
        }
        w.SubCells.Add(block);
    }

    private static void CopyInteriorCells(IFallout4ModGetter src, Fallout4Mod dst)
    {
        if (src.Cells.Records.Count == 0) return;
        var srcBlock = src.Cells.Records[0];
        if (srcBlock.SubBlocks.Count == 0) return;
        var srcSub = srcBlock.SubBlocks[0];

        var sub = new CellSubBlock { BlockNumber = srcSub.BlockNumber };
        foreach (var c in srcSub.Cells.Take(CellsPerSubBlock))
            sub.Cells.Add(TrimCell(c.DeepCopy()));
        var block = new CellBlock { BlockNumber = srcBlock.BlockNumber };
        block.SubBlocks.Add(sub);
        dst.Cells.Records.Add(block);
    }

    // Keep placed refs bounded — one real cell can hold thousands.
    private static Cell TrimCell(Cell c)
    {
        Trim(c.Persistent);
        Trim(c.Temporary);
        return c;
    }

    private static void Trim<T>(IList<T> list)
    {
        while (list.Count > RefsPerCell) list.RemoveAt(list.Count - 1);
    }

    // Walk up from the test output directory to the project's source TestData folder so the
    // regenerated file lands where git tracks it (not just in bin/).
    private static string SourceTestDataDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "MEditService.TestSupport.csproj")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return Path.Combine(dir.FullName, "TestData");
    }
}
