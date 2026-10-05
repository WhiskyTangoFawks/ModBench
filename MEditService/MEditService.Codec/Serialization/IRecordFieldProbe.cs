using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Serialization;

/// <summary>What a plugin's own bytes say of a record that the overlay does not.</summary>
public interface IRecordFieldProbe
{
    /// <summary>Whether the record holds no subrecord but its EditorID, which its header carries.</summary>
    bool HoldsNoFields(FormKey formKey);
}
