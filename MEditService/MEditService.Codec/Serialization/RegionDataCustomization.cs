using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Codec.Serialization;

/// <summary>Every region data entry redeclares these two members its base declares, and the
/// generated serializer writes both declarations, so the base's copy is the one left out: each
/// entry's own write and read carry the value.</summary>
internal sealed class RegionDataCustomization : ICustomize<IRegionDataGetter>
{
    public void CustomizeFor(ICustomizationBuilder<IRegionDataGetter> builder)
    {
        builder
            .Omit(x => x.LodDisplayDistanceMultiplier)
            .Omit(x => x.OcclusionAccuracyDist);
    }
}
