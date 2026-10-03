using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Codec.Serialization;

/// <summary>Filename numbering is off (ADR-0006). No Omit* call exists (ADR-0006): Omit*Data drops real fields.</summary>
internal sealed class RecordTextCodecCustomization : ICustomize
{
    public void Customize(ICustomizationBuilder builder)
    {
        builder
            .FilePerRecord();
    }
}
