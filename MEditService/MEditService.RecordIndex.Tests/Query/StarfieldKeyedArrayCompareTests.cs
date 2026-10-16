using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Starfield;
using Noggog;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class StarfieldKeyedArrayCompareTests
{
    private static readonly ModKey Base = ModKey.FromFileName("Base.esm");
    private static readonly ModKey Top = ModKey.FromFileName("Top.esp");
    private const uint LeveledPackInId = 0x800;
    private const uint TagSetId = 0x801;
    private static readonly FormKey LeveledPackInKey = new(Base, LeveledPackInId);
    private static readonly FormKey TagSetKey = new(Base, TagSetId);
    private static readonly FormKey A = new(Base, 0x900);

    [Theory]
    [InlineData(LeveledPackInId, "Entries")]
    [InlineData(TagSetId, "Tags")]
    public void ACopyHoldingEntriesAlikeButForTheirConditions_OrTagsByName_InAnotherOrder_IsIdenticalToMaster(uint recordId, string field)
    {
        using var scratch = new ScratchDirectory("medit-starfield-keyed-arrays-");
        var (basePath, topPath) = Write(scratch.Path);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, scratch.Path,
        [
            new LoadOrderEntry(Base.FileName, basePath, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true),
            new LoadOrderEntry(Top.FileName, topPath, PluginOrigin.DataDirectory, 1, Enabled: true, Winning: true),
        ], GameRelease.Starfield);

        var diff = index.Queries.GetCompare(new FormKey(Base, recordId).ToString()).Value().Require().Diffs.Single(d => d.FieldName == field);

        Assert.Equal(ConflictThis.IdenticalToMaster, diff.CellStates[Top.FileName]);
    }

    private static (string Base, string Top) Write(string folder)
    {
        var master = new StarfieldMod(Base, StarfieldRelease.Starfield);
        HoldEntriesAlikeButForTheirConditionsAndTwoTags(master, reversed: false);
        var basePath = Path.Combine(folder, Base.FileName);
        master.WriteToBinary(basePath);

        var top = new StarfieldMod(Top, StarfieldRelease.Starfield);
        top.ModHeader.MasterReferences.Add(new MasterReference { Master = Base });
        HoldEntriesAlikeButForTheirConditionsAndTwoTags(top, reversed: true);
        var topPath = Path.Combine(folder, Top.FileName);
        top.WriteToBinary(topPath, new BinaryWriteParameters
        {
            MastersListContent = MastersListContentOption.NoCheck,
            MasterFlagsLookup = new Cache<IModMasterStyledGetter, ModKey>(m => m.ModKey) { master },
        });
        return (basePath, topPath);
    }

    private static void HoldEntriesAlikeButForTheirConditionsAndTwoTags(StarfieldMod mod, bool reversed)
    {
        var entries = new[] { EntryHeldWhen(1), EntryHeldWhen(2) };
        mod.LeveledPackIns.Add(new LeveledPackIn(LeveledPackInKey, StarfieldRelease.Starfield) { Entries = [.. reversed ? entries.Reverse() : entries] });
        var tags = new[] { new AnimationSoundTag { Tag = "a" }, new AnimationSoundTag { Tag = "b" } };
        mod.AnimationSoundTagSets.Add(new AnimationSoundTagSet(TagSetKey, StarfieldRelease.Starfield) { Tags = [.. reversed ? tags.Reverse() : tags] });
    }

    private static LeveledPackInEntry EntryHeldWhen(float comparison)
    {
        var entry = new LeveledPackInEntry { Level = 1, Count = 1 };
        entry.Reference.SetTo(A);
        entry.Conditions.Add(new ConditionFloat { Data = new GetIsIDConditionData(), ComparisonValue = comparison });
        return entry;
    }
}
