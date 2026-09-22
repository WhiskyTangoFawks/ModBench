using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings.DI;

namespace MEditService.PluginAdapter.Tests.RealData;

/// <summary>Pins Mutagen-Modding/Mutagen#688 so a pin bump that walks <c>Structs[*].Members</c> names the
/// Kind A row to retire.</summary>
public sealed class ScriptStructListPropertyLinkGapTests
{
    private static readonly string FixturePath =
        Path.Combine(AppContext.BaseDirectory, "TestData", "SpaDia_AMR.esp");

    private static IScriptStructListPropertyGetter LoadLeveledListDataProperty()
    {
        var modKey = ModKey.FromFileName("SpaDia_AMR.esp");
        var modPath = new ModPath(modKey, FixturePath);
        var mod = ModFactory.ImportSetter(modPath, GameRelease.Fallout4, RealPluginReadParameters.For(PluginStrings.In((Path.GetDirectoryName(FixturePath) ?? throw new InvalidOperationException("Expected a parent directory.")))));

        var quest = mod.EnumerateMajorRecords().OfType<IQuestGetter>()
            .Single(q => q.EditorID == "DiaQ_LLInjector_SpadeyAMR");

        var adapter = quest.VirtualMachineAdapter
            ?? throw new InvalidOperationException("Expected DiaQ_LLInjector_SpadeyAMR to carry a VirtualMachineAdapter.");
        var script = adapter.Scripts.Single(s => s.Name == "DLC04:DLCLegendaryLLManagerScript");
        var property = script.Properties.Single(p => p.Name == "LeveledListData");
        return Assert.IsAssignableFrom<IScriptStructListPropertyGetter>(property);
    }

    [Fact]
    public void StructListProperty_OfTheRealSpaDiaAMRFixture_HoldsRealFormLinksMutagenDoesNotEnumerate()
    {
        var structList = LoadLeveledListDataProperty();

        // 1. The struct list genuinely has entries to look inside.
        Assert.NotEmpty(structList.Structs);

        // 2. Those structs' Members hold at least one FormLink-bearing property whose FormKey is real, the
        // exact content Mutagen #688 says EnumerateFormLinks skips. Asserted concretely against the real
        // master this fixture prunes.
        var nukaWorldFormKey = FormKey.Factory("03F98D:DLCNukaWorld.esm");
        var memberFormLinks = structList.Structs
            .SelectMany(s => s.Members)
            .OfType<IScriptObjectPropertyGetter>()
            .Select(p => p.Object.FormKey)
            .ToList();
        Assert.Contains(nukaWorldFormKey, memberFormLinks);

        // 3. The enumerator the diagnosis machinery and Referenced By rely on yields none of them: this is
        // Mutagen #688 itself, not a guess about it. The day this starts failing, Mutagen is fixed and this
        // file can retire.
        Assert.Empty(structList.EnumerateFormLinks());
    }
}
