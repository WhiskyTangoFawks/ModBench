using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class SkyrimTemplatedConflictTests : IDisposable
{
    private const string Base = "Base.esp";
    private const string Top = "Top.esp";

    private readonly ScratchDirectory _scratch = new("medit-skyrim-templated-conflict-");
    private readonly OpenedIndex _index;
    private readonly FormKey _npcKey;

    public SkyrimTemplatedConflictTests()
    {
        var holder = new LoadOrderHolder();
        var baseMod = new SkyrimMod(ModKey.FromFileName(Base), SkyrimRelease.SkyrimSE);
        var template = baseMod.Npcs.AddNew("Template");
        var npc = baseMod.Npcs.AddNew("Raider");
        npc.Configuration.MagickaOffset = 1;
        npc.Configuration.TemplateFlags = NpcConfiguration.TemplateFlag.Stats | NpcConfiguration.TemplateFlag.BaseData;
        var topMod = new SkyrimMod(ModKey.FromFileName(Top), SkyrimRelease.SkyrimSE);
        var copy = npc.DeepCopy();
        copy.Configuration.MagickaOffset = 50;
        copy.Configuration.TemplateFlags = NpcConfiguration.TemplateFlag.Stats | NpcConfiguration.TemplateFlag.BaseData;
        copy.Configuration.Flags = NpcConfiguration.Flag.Essential;
        copy.Template.SetTo(template.FormKey);
        topMod.Npcs.Add(copy);
        _npcKey = npc.FormKey;
        _index = Indexes.Open(holder);
        _index.Reconcile(holder, _scratch.Path, [Entry(baseMod, 0), Entry(topMod, 1)], GameRelease.SkyrimSE);
    }

    public void Dispose()
    {
        _index.Dispose();
        _scratch.Dispose();
    }

    private LoadOrderEntry Entry(SkyrimMod mod, int index)
    {
        var path = Path.Combine(_scratch.Path, mod.ModKey.FileName);
        ((IModGetter)mod).WriteToBinary(path);
        return new LoadOrderEntry(mod.ModKey.FileName, path, PluginOrigin.DataDirectory, index, Enabled: true, Winning: true);
    }

    private FieldDiff Row(string field) =>
        (_index.Queries.GetCompare(_npcKey.ToString()).Value() ?? throw new InvalidOperationException($"Expected {_npcKey} to compare."))
            .Diffs.Single(d => d.FieldName == field);

    [Fact]
    public void AStructWhoseOnlyDifferencesAreATemplatedMemberAndATemplatedBit_IsNoConflict_AsTheyAre()
    {
        var configuration = Row("Configuration");

        Assert.Equal(ConflictThis.IdenticalToMaster, configuration.CellStates[Top]);
        Assert.Equal(ConflictAll.NoConflict, configuration.ConflictAll);
    }

    [Fact]
    public void AFlagsRowWhoseOnlyDifferenceIsATemplatedBit_IsNoConflict_AsTheBitIs()
    {
        var flags = Assert.Single(Row("Configuration").Children.Require(), d => d.FieldName == "Flags");

        Assert.Equal(ConflictThis.IdenticalToMaster, flags.CellStates[Top]);
        Assert.Equal(ConflictAll.NoConflict, flags.ConflictAll);
    }

    [Fact]
    public void TheRowNamingTheTemplate_KeepsItsConflictColour()
    {
        Assert.NotEqual(ConflictAll.NoConflict, Row("Template").ConflictAll);
    }
}
