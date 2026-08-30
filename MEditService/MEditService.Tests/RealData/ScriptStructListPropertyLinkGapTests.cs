using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings.DI;

namespace MEditService.Tests.RealData;

/// <summary>
/// #520 AC3, the mechanism assertion: Mutagen-Modding/Mutagen#688's own shape, pinned against the
/// real <c>SpaDia_AMR.esp</c> fixture (Quest <c>DiaQ_LLInjector_SpadeyAMR</c>,
/// <c>0000DD:SpaDia_AMR.esp</c>) so the day the upstream pin bumps and starts walking
/// <c>Structs[*].Members</c>, this test goes red and names the row (<c>PluginDiagnosis.KindATable</c>,
/// <c>MasterPruningRoundTripGateTests</c>' own #520 fixture pin) to retire.
///
/// <para><b>Why this asserts more than the bare empty check.</b> An earlier draft of this test
/// asserted only <c>Assert.Empty(structList.EnumerateFormLinks())</c> — passing today, but for a
/// reason indistinguishable from a wrong property lookup: a typo'd property name, a bad cast, or a
/// null-coalesce to nothing would <i>also</i> leave that collection empty, and would keep passing
/// forever even after Mutagen starts walking struct members, since a lookup that finds nothing still
/// enumerates nothing. The three assertions before the empty check establish, independently, that
/// the property genuinely holds real FormLinks Mutagen isn't walking — so the final assertion means
/// what it claims to mean.</para>
/// </summary>
public sealed class ScriptStructListPropertyLinkGapTests
{
    private static readonly string FixturePath =
        Path.Combine(AppContext.BaseDirectory, "TestData", "SpaDia_AMR.esp");

    /// <summary>The quest and property #520 names, deep-parsed once and shared by every assertion
    /// below — all reading the same live object, not independently re-derived ones.</summary>
    private static IScriptStructListPropertyGetter LoadLeveledListDataProperty()
    {
        var modKey = ModKey.FromFileName("SpaDia_AMR.esp");
        var modPath = new ModPath(modKey, FixturePath);
        var mod = ModFactory.ImportSetter(modPath, GameRelease.Fallout4, LocalizedStrings.ForRead(Path.GetDirectoryName(FixturePath)!));

        var quest = mod.EnumerateMajorRecords().OfType<IQuestGetter>()
            .Single(q => q.EditorID == "DiaQ_LLInjector_SpadeyAMR");

        var script = quest.VirtualMachineAdapter!.Scripts.Single(s => s.Name == "DLC04:DLCLegendaryLLManagerScript");
        var property = script.Properties.Single(p => p.Name == "LeveledListData");
        return Assert.IsAssignableFrom<IScriptStructListPropertyGetter>(property);
    }

    [Fact]
    public void StructListProperty_OfTheRealSpaDiaAMRFixture_HoldsRealFormLinksMutagenDoesNotEnumerate()
    {
        var structList = LoadLeveledListDataProperty();

        // 1. The struct list genuinely has entries to look inside.
        Assert.NotEmpty(structList.Structs);

        // 2. Those structs' own Members hold at least one FormLink-bearing property (ScriptObjectProperty)
        // whose FormKey is real, not FormKey.Null/default — the exact content #688 says Mutagen's own
        // EnumerateFormLinks skips. Asserted concretely against DLCNukaWorld.esm's own record, the
        // real master #520's fixture prunes, not merely "some non-null FormKey".
        var nukaWorldFormKey = FormKey.Factory("03F98D:DLCNukaWorld.esm");
        var memberFormLinks = structList.Structs
            .SelectMany(s => s.Members)
            .OfType<IScriptObjectPropertyGetter>()
            .Select(p => p.Object.FormKey)
            .ToList();
        Assert.Contains(nukaWorldFormKey, memberFormLinks);

        // 3. The enumerator #513/#514's own diagnosis machinery and Referenced By both rely on yields
        // none of them — this is Mutagen#688 itself, not a guess about it. The day this line starts
        // failing (yielding the link above), Mutagen has been fixed and this whole file, the
        // PluginDiagnosis.KindATable #688 row, and MasterPruningRoundTripGateTests' SpaDia_AMR fixture
        // are all ready to retire together.
        Assert.Empty(structList.EnumerateFormLinks());
    }
}
