using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Testing;
using Shouldly;

namespace Mutagen.Bethesda.UnitTests.Plugins.Records.Fallout4;

/// <summary>
/// MEditService#385: FO4 ObjectTemplate's on-disk subrecord order is OBTF, FULL, OBTS. The lazy
/// overlay reader (Fallout4ModBinaryOverlay) locates ObjectTemplate list-item boundaries via
/// ObjectTemplate_Registration.AllRecordTypes.IndexOf(recordType) in
/// PluginBinaryOverlay.ParseRecordLocationsInternal, starting a new item whenever the index fails
/// to strictly increase. When AllRecordTypes is alphabetized to (FULL, OBTF, OBTS) -- as it was
/// between 0.54.0 and 0.54.1 -- the on-disk OBTF -> FULL transition (index 1 -> 0) looks like a
/// decrease and the overlay splits this single template into two. Fallout4Mod.CreateFromBinary
/// (the <see cref="ASpecificCaseTest{TSetter,TGetter}.Direct"/> path below) never consults this
/// ordering and stays correct -- only <see cref="ASpecificCaseTest{TSetter,TGetter}.Overlay"/> is
/// affected. The fixture is a single WEAP record with exactly one ObjectTemplate carrying all
/// three subrecords (IsEditorOnly=true so OBTF is present) in on-disk order OBTF, FULL, OBTS -- the
/// minimal shape that reproduces the split. <see cref="TestPassthrough"/> (inherited, true by
/// default) additionally asserts both parse paths write back byte-identical to the source.
/// </summary>
public class ObjectTemplateOrderRegressionTests : ASpecificCaseTest<Weapon, IWeaponGetter>
{
    public static string ObjectTemplateOrder = "Files/Fallout4/ObjectTemplateOrder.esp";

    public override ModPath Path => ObjectTemplateOrder;
    public override GameRelease Release => GameRelease.Fallout4;

    public override void TestItem(IWeaponGetter item)
    {
        item.ObjectTemplates.ShouldNotBeNull();
        item.ObjectTemplates!.Count.ShouldBe(1);
    }
}
