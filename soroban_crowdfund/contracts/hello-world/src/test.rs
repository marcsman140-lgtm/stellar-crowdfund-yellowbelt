#![cfg(test)]
use super::*;
use soroban_sdk::{Env, Address, testutils::Address as _};

#[test]
fn test_crowdfund_donate_and_total() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, CrowdfundContract);
    let client = CrowdfundContractClient::new(&env, &contract_id);

    assert_eq!(client.get_total(), 0);

    let donor1 = Address::generate(&env);
    let new_total = client.donate(&donor1, &150);
    assert_eq!(new_total, 150);
    assert_eq!(client.get_total(), 150);

    let donor2 = Address::generate(&env);
    let updated_total = client.donate(&donor2, &250);
    assert_eq!(updated_total, 400);
    assert_eq!(client.get_total(), 400);
}
