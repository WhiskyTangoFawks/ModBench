using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Codec.Serialization;

/// <summary>Filename numbering is off (ADR-0006): no list carries order, and a numbered
/// name would carry one. No Omit* call exists: the ADR admits no loss, and Omit*Data drops
/// real fields.</summary>
internal sealed class RecordTextCodecCustomization : ICustomize
{
    public void Customize(ICustomizationBuilder builder)
    {
        builder
            .FilePerRecord();
    }
}
