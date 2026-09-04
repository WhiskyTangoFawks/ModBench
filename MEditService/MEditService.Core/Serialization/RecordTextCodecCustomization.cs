using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Core.Serialization;

/// <summary>Filename numbering is off (ADR-0042 decision 4): order is the parent's,
/// and a numbered name would be a contradicting second carrier. No Omit* call exists: decision 3
/// admits no exception, and Omit*Data drops real fields.</summary>
public sealed class RecordTextCodecCustomization : ICustomize
{
    public void Customize(ICustomizationBuilder builder)
    {
        builder
            .FilePerRecord();
    }
}
