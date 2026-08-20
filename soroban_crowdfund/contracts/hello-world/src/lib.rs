#![no_std]
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

const TOTAL_KEY: Symbol = symbol_short!("TOTAL");

#[contract]
pub struct CrowdfundContract;

#[contractimpl]
impl CrowdfundContract {
    /// Allows a donor to contribute an amount to the pool and publishes a real-time event.
    pub fn donate(env: Env, donor: Address, amount: i128) -> i128 {
        donor.require_auth();
        let mut total: i128 = env.storage().instance().get(&TOTAL_KEY).unwrap_or(0);
        total += amount;
        env.storage().instance().set(&TOTAL_KEY, &total);

        // Emit real-time event for frontend stream listening
        env.events().publish((symbol_short!("donate"), donor), amount);

        total
    }

    /// Returns the current accumulated donation total from storage.
    pub fn get_total(env: Env) -> i128 {
        env.storage().instance().get(&TOTAL_KEY).unwrap_or(0)
    }
}

mod test;
